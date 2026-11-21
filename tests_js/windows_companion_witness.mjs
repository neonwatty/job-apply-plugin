import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Witness for windows_companion_shutdown.test.mjs: the real supervisor, launcher and jobs
// server, with a small stand-in for the Next server so the suite needs no Companion build.
const source = fileURLToPath(new URL('..', import.meta.url));
const stub = `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const server = createServer((request, response) => {
  response.writeHead(request.url === '/api/boot' ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end('{}');
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME, () => {
  writeFileSync(process.env.JOB_APPLY_TEST_COMPANION, JSON.stringify({ pid: process.pid, parent: process.ppid }));
});
`;

function children(parent) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent} AND Name='node.exe'" | ForEach-Object { $_.ProcessId }`],
  { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return result.stdout.split(/\s+/).filter(Boolean).map(Number);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function gone(pids) {
  for (let i = 0; i < 200 && pids.some(alive); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(pids.filter(alive), [], 'every Companion process exits');
}

const temporary = await realpath(process.argv[3]), artifact = process.argv[2];
const plugin = join(temporary, 'plugin');
const root = join(temporary, 'store');
for (const path of ['package.json', 'runtime', 'apps/companion/launch.mjs', 'apps/companion/supervise.mjs',
  'apps/companion/writer-route.mjs', 'apps/companion/ensure-standalone.mjs', 'apps/companion/standalone-assets.mjs']) {
  await cp(join(source, path), join(plugin, path), { recursive: true });
}
const server = join(plugin, 'apps/companion/.next/standalone/apps/companion');
await mkdir(server, { recursive: true });
await writeFile(join(server, 'server.js'), stub);
const record = join(temporary, 'companion.json');
process.env.JOB_APPLY_TEST_COMPANION = record;

const { runSupervisor } = await import(pathToFileURL(join(plugin, 'apps/companion/supervise.mjs')).href);
const options = { root, pluginRoot: plugin, port: 0, nativeLock: artifact,
  legacyProfile: join(temporary, 'no-profile.json'), dev: false };
for (const round of ['fresh', 'reopen']) {
  const running = await runSupervisor(options);
  const ready = JSON.parse(running.line), url = new URL(ready.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.hash, /^#token=[A-Za-z0-9_-]{32,}$/);
  const companion = JSON.parse(await readFile(record, 'utf8'));
  const launcher = companion.parent, owned = children(launcher);
  assert.ok(owned.includes(companion.pid), round);
  assert.equal(owned.length, 2, `${round}: the launcher owns the jobs server and the Companion server`);
  assert.ok((await readdir(root)).includes('.job-apply-writer.lock'));

  await running.controller.stop();
  await running.completion;
  await gone([launcher, ...owned]);
}
// The Store stays a valid native Store after both lifetimes.
const entries = await readdir(root);
assert.ok(entries.includes('.native-store-clone'));
assert.ok(!entries.includes('.native-store-pending'));
await writeFile(join(temporary, 'done'), 'ok');
