import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureStandalone } from '../apps/companion/ensure-standalone.mjs';
import { openWindowsStoreFile, withWindowsStore } from '../runtime/store/windows-store.js';

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

const legacy = join(temporary, 'legacy');
await mkdir(legacy);
const legacyJobs = join(legacy, 'jobs.json');
await writeFile(legacyJobs, '{}\n');
const refused = spawnSync(process.execPath, [
  join(plugin, 'apps/companion/launch.mjs'), '--dev', '--native-lock', artifact, '--root', legacy,
], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
assert.ifError(refused.error);
assert.equal(refused.status, 1, refused.stderr);
assert.match(refused.stderr, /It was left unchanged.*--root or JOB_APPLY_STORE_DIR/);
assert.deepEqual(await readdir(legacy), ['jobs.json']);
assert.equal(await readFile(legacyJobs, 'utf8'), '{}\n');

async function verifyBuildCancellation() {
  const plugin = join(temporary, 'cancellation-install');
  await mkdir(join(plugin, 'apps', 'companion'), { recursive: true });
  for (const path of ['native/windows', 'native/packaged-lock/win32-x64-napi8']) {
    await cp(new URL(`../${path}`, import.meta.url), join(plugin, path), { recursive: true });
  }
  const npm = join(temporary, 'npm-cli.js');
  await writeFile(npm, `
    const fs = require('node:fs');
    const root = require('node:path');
    if (process.argv[2] === 'run') {
      const gate = root.join(process.cwd(), 'finish-build');
      fs.writeFileSync(root.join(process.cwd(), 'build-started'), '');
      const timer = setInterval(() => {
        if (fs.existsSync(gate)) {
          fs.writeFileSync(root.join(process.cwd(), 'build-finished'), '');
          clearInterval(timer);
        }
      }, 20);
      setTimeout(() => process.exit(1), 15000).unref();
    }
  `);
  const oldNpm = process.env.npm_execpath;
  process.env.npm_execpath = npm;
  const controller = new AbortController();
  const reason = new Error('Cancelled source build');
  const building = assert.rejects(ensureStandalone(plugin, { signal: controller.signal }), reason);
  building.catch(() => {});
  const gate = join(plugin, 'finish-build'), started = join(plugin, 'build-started');
  try {
    for (let poll = 0; poll < 240 && !existsSync(started); poll += 1) await delay(25);
    assert.ok(existsSync(started), 'npm build step started');
    controller.abort(reason);
    await delay(200);
    const lockDir = join(plugin, 'apps/companion/.companion-build');
    const addon = join(plugin, 'native/packaged-lock/win32-x64-napi8/flock.node');
    await withWindowsStore(lockDir, addon, async provider => {
      const handle = await openWindowsStoreFile(join(lockDir, 'lock'), constants.O_RDWR);
      try {
        const locked = provider.tryLock(handle.fd);
        if (locked) provider.unlock(handle.fd);
        assert.equal(locked, false, 'build lock remains held after cancellation');
      } finally { await handle.close(); }
    });
  } finally {
    controller.abort(reason);
    await writeFile(gate, '');
    if (oldNpm === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = oldNpm;
    await building;
  }
  assert.ok(existsSync(join(plugin, 'build-finished')));
}

await verifyBuildCancellation();
await writeFile(join(temporary, 'done'), 'ok');
