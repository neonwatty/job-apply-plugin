import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { physicalLines, loadBaseline, checkSize } from '../tools/check-source-size.mjs';
import { checkLinks } from '../tools/check-links.mjs';
import { requiredEnvironment } from '../tools/ci/required-environment.mjs';

test('required validation rejects interpreter subprocesses including absolute executables', async () => {
  const host = await requiredEnvironment();
  try {
    for (const command of ['python3', '/usr/bin/python3', 'python3.13', 'uv']) {
      const script = `import {spawnSync} from 'node:child_process'; try { spawnSync(${JSON.stringify(command)}, ['--version']); process.exitCode=1; } catch(e) { console.log(e.code); }`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: host.environment, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'PYTHON_NOT_ALLOWED');
    }
    const promisified = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {execFile} from 'node:child_process'; import {promisify} from 'node:util';
      const result=await promisify(execFile)(process.execPath,['-e','process.stdout.write("out");process.stderr.write("err")']);
      console.log(JSON.stringify(result));
      try { await promisify(execFile)('/usr/bin/python3',['--version']); process.exitCode=1; }
      catch(error) { if(error.code!=='PYTHON_NOT_ALLOWED') throw error; }
    `], { env: host.environment, encoding: 'utf8' });
    assert.equal(promisified.status, 0, promisified.stderr);
    assert.deepEqual(JSON.parse(promisified.stdout), { stdout: 'out', stderr: 'err' });
    const shell = spawnSync('/bin/sh', ['-c', 'python3 --version'], { env: host.environment, encoding: 'utf8' });
    assert.equal(shell.status, 86);
    assert.match(shell.stderr, /CPython is disabled/);
  } finally { await host.cleanup(); }
});

test('source policy counts physical UTF-8 lines and validates baseline metadata', () => {
  assert.equal(physicalLines(Buffer.from('')), 0);
  assert.equal(physicalLines(Buffer.from('λ\nlast')), 2);
  assert.equal(physicalLines(Buffer.from('one\r\ntwo\n')), 2);
  assert.throws(() => loadBaseline('{"version":1,"maximumLines":500,"files":{"../escape.ts":{"ceiling":501,"owner":"a","reason":"b","removalPhase":"c"}}}'), /invalid/);
  assert.throws(() => loadBaseline('{"version":1,"maximumLines":500,"files":{"file.ts":{"ceiling":true}}}'), /invalid/);
});

test('source policy rejects new oversized files and raised baseline ceilings', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ts-source-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env,
      GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  git(['init', '-q']);
  const entry = { ceiling: 501, owner: 'test', reason: 'legacy fixture', removalPhase: 'test' };
  await writeFile(join(root, 'legacy.ts'), '// line\n'.repeat(501));
  const baseline = { version: 1, maximumLines: 500, files: { 'legacy.ts': entry } };
  await writeFile(join(root, '.source-size-baseline.json'), JSON.stringify(baseline));
  git(['add', '.']); git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'synthetic baseline']);
  assert.deepEqual(checkSize(root, 'HEAD'), []);
  await writeFile(join(root, 'new.ts'), '// line\n'.repeat(501));
  assert.ok(checkSize(root, 'HEAD').some(error => error.includes('new.ts: 501 > 500')));
  baseline.files['legacy.ts'].ceiling = 502;
  await writeFile(join(root, '.source-size-baseline.json'), JSON.stringify(baseline));
  assert.ok(checkSize(root, 'HEAD').some(error => error.includes('ceiling increased')));
});

test('release links reject broken and escaping symlinks while accepting reachable internal targets', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'native-links-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repository'); await mkdir(join(root, 'site'), { recursive: true });
  await writeFile(join(root, 'site/index.html'), '<html></html>');
  await writeFile(join(root, 'README.md'), '[link](linked.md)');
  await symlink('missing.md', join(root, 'linked.md'));
  await assert.rejects(checkLinks(root, { network: false }), { code: 'ENOENT' });
  await rm(join(root, 'linked.md'));
  await writeFile(join(temporary, 'outside.md'), 'outside');
  await symlink(join(temporary, 'outside.md'), join(root, 'linked.md'));
  await assert.rejects(checkLinks(root, { network: false }), /escapes repository/);
  await rm(join(root, 'linked.md'));
  await writeFile(join(root, 'inside.md'), 'inside');
  await symlink('inside.md', join(root, 'linked.md'));
  await checkLinks(root, { network: false });
  await writeFile(join(root, 'README.md'), '[![badge](https://127.0.0.1:1/badge)](inside.md)');
  await checkLinks(root); // Remote image URLs are cosmetic; the surrounding link is checked.
});
