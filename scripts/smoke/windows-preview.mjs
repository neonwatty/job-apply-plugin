import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const entry = fileURLToPath(import.meta.url);
const repository = 'neonwatty/job-apply-plugin';
const sourceUrl = `https://github.com/${repository}.git`;
const catalog = 'neonwatty-plugins-preview';
const plugin = `job-apply@${catalog}`;
const job = { id: 'windows-preview-smoke', url: 'https://example.invalid/preview', role: 'Test engineer' };

function run(executable, args, options = {}) {
  return execute(executable, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options });
}

async function previewHead() {
  const { stdout } = await run('git', ['ls-remote', sourceUrl, 'refs/heads/main']);
  const sha = stdout.trim().split(/\s+/)[0];
  assert.match(sha, /^[a-f0-9]{40}$/, 'preview must resolve to a Git commit');
  return sha;
}

async function verifySource(installed, source) {
  // Git on Windows can translate text line endings. Native receipts bind exact source and binary bytes.
  const text = bytes => bytes.toString('utf8').replaceAll('\r\n', '\n');
  for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'package-lock.json',
    'apps/companion/command.mjs', 'apps/companion/launch.mjs', 'runtime/cli/native-jobs.js',
    'runtime/cli/native-store-migration.js', 'runtime/store/native-store-clone.js',
    'runtime/store/windows-activation.js', 'runtime/store/windows-migration-source.js',
    'runtime/store/windows-store-migration.js']) {
    const [actual, expected] = await Promise.all([readFile(join(installed, path)), readFile(join(source, path))]);
    assert.ok(text(actual) === text(expected), `installed preview differs from main in ${path}`);
  }
  for (const path of ['native/packaged-lock/win32-x64-napi8/flock.node', 'native/packaged-lock/win32-x64-napi8/receipt.json',
    'native/windows/flock.c', 'native/windows/store-metadata.h']) {
    const [actual, expected] = await Promise.all([readFile(join(installed, path)), readFile(join(source, path))]);
    assert.ok(actual.equals(expected), `installed preview differs from main in ${path}`);
  }
}

async function installPreview(host, profile, sha) {
  await mkdir(profile);
  const configKey = host === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  // Use the global npm shims. The command arguments are fixed preview-marketplace identifiers.
  const invoke = (...args) => run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [host, ...args].join(' ')],
    { env: { ...process.env, [configKey]: profile } });
  if (host === 'codex') {
    await invoke('plugin', 'marketplace', 'add', repository, '--ref', 'preview-catalog', '--json');
    await invoke('plugin', 'add', plugin, '--json');
    const listing = JSON.parse((await invoke('plugin', 'list', '--json')).stdout);
    const installed = listing.installed.find(item => item.pluginId === plugin);
    assert.equal(installed?.enabled, true);
    assert.equal(installed.source?.url, sourceUrl, 'Codex preview must use the public repository');
    assert.equal(installed.source?.ref, 'main', 'Codex preview must track main');
  } else {
    await invoke('plugin', 'marketplace', 'add', `${repository}#preview-catalog`);
    await invoke('plugin', 'install', plugin);
    const listing = JSON.parse(await readFile(join(profile, 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries = listing.plugins[plugin];
    assert.equal(entries?.length, 1, 'expected one isolated Claude installation record');
    assert.equal(entries[0].gitCommitSha, sha, 'Claude preview install must match the checkout SHA');
  }
  const versions = join(profile, 'plugins', 'cache', catalog, 'job-apply');
  const entries = await readdir(versions, { withFileTypes: true });
  const installed = entries.filter(item => item.isDirectory());
  assert.equal(installed.length, 1, 'expected one isolated preview install');
  return realpath(join(versions, installed[0].name));
}

async function request(origin, token, path, payload) {
  const response = await fetch(origin + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `Companion request failed for ${path}`);
  return path === '/' ? response.text() : response.json();
}

async function smokeCompanion(installed, store) {
  const fromInstall = path => import(pathToFileURL(join(installed, 'apps', 'companion', path)).href);
  const { ensureStandalone } = await fromInstall('ensure-standalone.mjs');
  const { runSupervisor } = await fromInstall('supervise.mjs');
  const options = { pluginRoot: installed, root: store, port: 0, dev: false };
  assert.equal(await ensureStandalone(installed, { report: message => process.stdout.write(message + '\n') }), true,
    'a fresh preview install must build Companion');
  for (const firstStart of [true, false]) {
    const running = await runSupervisor(options);
    running.completion.catch(() => {});
    try {
      const startup = JSON.parse(running.line);
      const url = new URL(startup.url);
      const token = new URLSearchParams(url.hash.slice(1)).get('token');
      assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === startup.origin && token,
        'invalid private Companion startup URL');
      assert.match(await request(url.origin, token, '/'), /<html[\s>]/i);
      const boot = await request(url.origin, token, '/api/boot');
      assert.equal(boot.mode, 'native-store-clone');
      if (firstStart) {
        const saved = await request(url.origin, token, '/api/jobs', { job });
        assert.equal(saved.id, job.id);
      } else {
        const data = await request(url.origin, token, '/api/jobs');
        assert.equal(data.jobs.find(saved => saved.id === job.id)?.role, job.role,
          'the saved job must survive Companion restart');
      }
    } finally {
      await running.controller.stop();
      await running.completion;
    }
  }
}

async function smokeMigration(installed, source, root) {
  const fixture = join(source, 'test', 'fixtures', 'python-store-v1.1.0', 'store');
  const legacy = join(root, 'legacy Store');
  const migrated = join(root, 'migrated Store');
  const recovery = join(root, 'recovery Store');
  const addon = createRequire(import.meta.url)(join(installed, 'native', 'packaged-lock', 'win32-x64-napi8', 'flock.node'));
  addon.createStoreEntry(legacy, true);
  addon.createStoreEntry(join(legacy, 'sessions'), true);
  addon.createStoreEntry(join(legacy, '.store.lock'), false);
  const files = ['profile.json', 'answers.json', 'applications.jsonl', 'sessions/legacy-application.json'];
  for (const name of files) {
    const path = join(legacy, name);
    addon.createStoreEntry(path, false);
    await writeFile(path, await readFile(join(fixture, name)));
  }

  const command = join(installed, 'apps', 'companion', 'command.mjs');
  const cli = async (...args) => {
    const { stdout } = await run(process.execPath, [command, ...args], {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, JOB_APPLY_STORE_DIR: '' },
    });
    return JSON.parse(stdout);
  };
  const check = await cli('migration', 'check', '--source', legacy);
  assert.deepEqual(check, { schemaVersion: 1, status: 'source-checked' });
  const copy = await cli('migration', 'copy', '--source', legacy, '--target', migrated);
  assert.deepEqual(copy, { schemaVersion: 1, status: 'copy-ready' });
  assert.deepEqual(await cli('store', 'job-list', '--root', migrated), []);

  const edit = { ...job, id: 'windows-preview-migration-edit' };
  const input = join(root, 'migration-edit.json');
  await writeFile(input, JSON.stringify(edit));
  const saved = await cli('store', 'job-create', '--root', migrated, '--input', input);
  assert.equal(saved.id, edit.id);

  const rollback = await cli('migration', 'rollback', '--source', legacy, '--migrated', migrated, '--target', recovery);
  assert.deepEqual(rollback, { schemaVersion: 1, status: 'recovery-ready' });
  assert.deepEqual(await cli('store', 'job-list', '--root', recovery), []);
  const jobs = await cli('store', 'job-list', '--root', migrated);
  assert.deepEqual(jobs.map(({ id, role }) => ({ id, role })), [{ id: edit.id, role: edit.role }]);
  for (const name of files) {
    const expected = await readFile(join(fixture, name));
    for (const store of [legacy, migrated, recovery]) {
      assert.deepEqual(await readFile(join(store, name)), expected, `migration fixture bytes changed in ${name}`);
    }
  }
}

async function smokePreview(host, source) {
  assert.ok(host === 'codex' || host === 'claude', 'expected the codex or claude host');
  const { stdout } = await run('git', ['-C', source, 'rev-parse', 'HEAD']);
  const sha = stdout.trim();
  assert.equal(await previewHead(), sha, 'main moved since checkout, rerun against the current preview');
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ja-')));
  try {
    const installed = await installPreview(host, join(root, host), sha);
    await verifySource(installed, source);
    assert.equal(await previewHead(), sha, 'main moved during install, rerun against the current preview');
    const store = join(root, 'store');
    const { stdout: initialized } = await run(process.execPath,
      [join(installed, 'apps/companion/command.mjs'), 'store', 'init', '--root', store]);
    assert.equal(JSON.parse(initialized).root, store);
    // The child releases its loaded Windows addon before we remove the host cache.
    const { stdout: output } = await run(process.execPath, [entry, '--installed', installed, source, store],
      { timeout: 900_000 });
    process.stdout.write(output);
    console.log(`${host}: Windows x64 preview checked against main ${sha}; saved and reopened a Companion job,`
      + ' migrated a legacy Store, and recovered the legacy snapshot while preserving the newer edit');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }
}

assert.ok(process.platform === 'win32' && process.arch === 'x64', 'Windows x64 is required');
const [mode, ...args] = process.argv.slice(2);
if (mode === '--installed') {
  const [installed, checkout, store] = args;
  await smokeCompanion(installed, store);
  await smokeMigration(installed, checkout, dirname(store));
} else {
  await smokePreview(mode, resolve(args[0]));
}
