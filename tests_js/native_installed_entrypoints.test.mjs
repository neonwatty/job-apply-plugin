import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';

async function installed(t) {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const plugin = join(fixture.root, 'plugin');
  await cp(new URL('../runtime/', import.meta.url), join(plugin, 'runtime'), { recursive: true });
  await mkdir(join(plugin, 'native', 'posix'), { recursive: true });
  await cp(new URL('../native/posix/flock.c', import.meta.url), join(plugin, 'native/posix/flock.c'));
  const platform = `${process.platform}-${process.arch}-napi8`;
  const lock = join(plugin, 'native', 'packaged-lock', platform);
  await mkdir(lock, { recursive: true });
  await cp(fixture.receipt.artifact, join(lock, 'flock.node'));
  const { schemaVersion, arch, platform: receiptPlatform, nodeApiVersion, sourceSha256, artifactSha256 } = fixture.receipt;
  await writeFile(join(lock, 'receipt.json'), JSON.stringify({ schemaVersion, arch, platform: receiptPlatform, nodeApiVersion, sourceSha256, artifactSha256 }));
  await writeFile(join(plugin, 'package.json'), '{"type":"module"}');
  const root = join(fixture.root, '.job-apply');
  await initializeJobsFixture(root);
  return { plugin, root };
}

function run(plugin, command, args = [], environment = {}) {
  return spawnSync(process.execPath, [join(plugin, 'runtime/cli', command), ...args], {
    cwd: plugin,
    encoding: 'utf8',
    env: { HOME: plugin.slice(0, plugin.lastIndexOf('/plugin')), PATH: '', ...environment },
  });
}

test('assembled prepared native Jobs CLI resolves the default root and packaged lock without Python', async t => {
  const { plugin } = await installed(t);
  const result = run(plugin, 'native-jobs.js', ['profile-get']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test('assembled prepared native task CLI resolves the default root and packaged lock without Python', async t => {
  const { plugin } = await installed(t);
  const result = run(plugin, 'native-task.js', ['snapshot']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).ok, true);
});

for (const command of ['native-jobs.js', 'native-task.js']) {
  test(`prepared native ${command} expands a home-relative configured Store`, async t => {
    const { plugin } = await installed(t);
    const result = run(plugin, command, [command === 'native-jobs.js' ? 'profile-get' : 'snapshot'],
      { JOB_APPLY_STORE_DIR: '~/.job-apply' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
  });
}

// Copy tracked source-package assets, without assembling or compiling an addon.
async function sourcePackage(t) {
  const home = await mkdtemp(join(tmpdir(), 'source-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const plugin = join(home, 'plugin');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const paths = spawnSync('git', ['ls-files', '-z', 'scripts', 'skills', 'runtime', 'native', 'qa', 'package.json'],
    { cwd: repository, encoding: 'utf8' });
  assert.equal(paths.status, 0, paths.stderr);
  for (const path of paths.stdout.split('\0').filter(Boolean)) {
    await mkdir(join(plugin, path, '..'), { recursive: true });
    await cp(join(repository, path), join(plugin, path));
  }
  assert.deepEqual(await readdir(join(plugin, 'native/packaged-lock')), ['README.md']);
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  const invoke = (executable, path, args) => spawnSync(executable, [join(plugin, path), ...args], {
    cwd: plugin, encoding: 'utf8',
    env: { HOME: home, PATH: '', JOB_APPLY_STORE_DIR: '~/.job-apply' },
  });
  return {
    home, plugin,
    python: args => invoke(python.stdout.trim(), 'scripts/job-apply-store.py', args),
    async documented(document, command, args = [], documentedCommand = command) {
      const text = await readFile(join(plugin, document), 'utf8');
      const match = text.match(new RegExp('(node|python3) "<plugin-root>/([^"\\n]+)"(?: \\[--root <resolved-root>\\])? ' + documentedCommand + '(?: |\\n|$)'));
      assert.ok(match, `missing documented ${documentedCommand} invocation in ${document}`);
      return invoke(match[1] === 'node' ? process.execPath : python.stdout.trim(), match[2], [command, ...args]);
    },
  };
}

function succeeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

for (const existing of [false, true]) {
  test(`source marketplace commands support ${existing ? 'an existing Python' : 'a fresh'} Store without native assembly`, async t => {
    const installed = await sourcePackage(t);
    if (existing) {
      succeeded(installed.python(['init']));
      const input = join(installed.home, 'profile-input.json');
      await writeFile(input, '{"firstName":"Synthetic Owner"}', { mode: 0o600 });
      succeeded(installed.python(['profile-replace', '--input', input, '--expected-revision', '1', '--source', 'user']));
    }
    const profilePath = join(installed.home, '.job-apply/profile.json');
    const before = existing ? await readFile(profilePath, 'utf8') : null;
    succeeded(await installed.documented('skills/answer-memory/SKILL.md', 'init'));
    const profile = succeeded(await installed.documented('skills/answer-memory/references/profile.md', 'profile-get'));
    assert.deepEqual(profile, existing ? { firstName: 'Synthetic Owner' } : {});
    const snapshot = succeeded(await installed.documented('skills/job-apply/references/intake.md', 'snapshot', [], 'intake'));
    assert.equal(snapshot.ok, true);
    if (existing) assert.equal(await readFile(profilePath, 'utf8'), before);
    assert.equal((await readdir(join(installed.home, '.job-apply'))).some(name => name.includes('native')), false);
    const path = join(installed.home, 'resume.txt');
    await writeFile(path, 'Synthetic source package resume', { mode: 0o600 });
    const input = join(installed.home, 'resume-input.json');
    await writeFile(input, JSON.stringify({ id: 'source-package-resume', label: 'Synthetic resume', path }), { mode: 0o600 });
    const resume = succeeded(await installed.documented('skills/answer-memory/references/resumes.md', 'resume-import', ['--input', input]));
    assert.equal(resume.id, 'source-package-resume');
    assert.equal(JSON.stringify(resume).includes(path), false);
  });
}
