import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture } from '../runtime/store/native-jobs.js';

// Copy tracked source-package assets, including the reviewed host addons.
async function sourcePackage(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'source-install-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const plugin = join(home, 'plugin');
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const paths = spawnSync('git', ['ls-files', '-z', 'apps/companion', 'scripts', 'skills', 'runtime', 'native', 'qa', 'package.json'],
    { cwd: repository, encoding: 'utf8' });
  assert.equal(paths.status, 0, paths.stderr);
  for (const path of paths.stdout.split('\0').filter(Boolean)) {
    await mkdir(join(plugin, path, '..'), { recursive: true });
    await cp(join(repository, path), join(plugin, path));
  }
  assert.deepEqual((await readdir(join(plugin, 'native/packaged-lock'))).sort(),
    ['README.md', 'darwin-arm64-napi8', 'linux-x64-napi8']);
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
      const match = text.match(new RegExp('node "<plugin-root>/(apps/companion/command\\.mjs)" (store|task|attempt|policy)(?: \\[--root <resolved-root>\\])? ' + documentedCommand + '(?: |`|\\n|$)'));
      assert.ok(match, `missing documented ${documentedCommand} invocation in ${document}`);
      return invoke(process.execPath, match[1], [match[2], command, ...args]);
    },
  };
}

function succeeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

for (const existing of [false, true]) {
  test(`source marketplace commands support ${existing ? 'an existing Python' : 'a fresh'} Store from reviewed native artifacts`, async t => {
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
    assert.ok((await readdir(join(installed.home, '.job-apply'))).includes('.native-store-clone'));
    assert.ok((await readdir(installed.home)).includes('.job-apply.python-rollback'));
    const path = join(installed.home, 'resume.txt');
    await writeFile(path, 'Synthetic source package resume', { mode: 0o600 });
    const input = join(installed.home, 'resume-input.json');
    await writeFile(input, JSON.stringify({ id: 'source-package-resume', label: 'Synthetic resume', path }), { mode: 0o600 });
    const resume = succeeded(await installed.documented('skills/answer-memory/references/resumes.md', 'resume-import', ['--input', input]));
    assert.equal(resume.id, 'source-package-resume');
    assert.equal(JSON.stringify(resume).includes(path), false);
  });
}
