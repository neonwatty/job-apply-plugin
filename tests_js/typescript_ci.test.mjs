import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
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

test('release links resolve local Markdown headings, duplicate slugs and explicit anchors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'markdown-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'site'));
  await writeFile(join(root, 'site/index.html'), '<main id="content"><a href="#content">Skip</a></main>');
  await writeFile(join(root, 'README.md'), [
    '# Start *here*',
    '[Same file](#start-here) and [guide][guide].',
    '',
    '[guide]: <guide notes.md#quick-start>',
    '',
    '[Same heading name in another file](/guide%20notes.md#start-here)',
    '[Repeated](guide%20notes.md#quick-start-2)',
    '[Case and Unicode](guide%20notes.md#caf%C3%A9--cli)',
    '[Custom anchor](guide%20notes.md#install-here)',
    '[Source line](guide%20notes.md?plain=1#L2)',
    '[HTML source](site/index.html#L1)',
    '[Text source](README.txt#L1)',
    '[Top](#)',
    '',
  ].join('\n'));
  await writeFile(join(root, 'guide notes.md'), [
    '# Start here',
    '# Quick Start',
    '# Quick Start-1',
    'Quick Start',
    '-----------',
    '## **Café** &amp; `CLI`!',
    '<a name="install-here"></a>',
    '',
  ].join('\n'));
  await rename(join(root, 'README.md'), join(root, 'README.txt'));
  await symlink('README.txt', join(root, 'README.md'));
  await rename(join(root, 'guide notes.md'), join(root, 'guide.source'));
  await symlink('guide.source', join(root, 'guide notes.md'));
  await checkLinks(root, { network: false });
});

test('release links fail missing Markdown fragments even when the destination exists', async t => {
  const root = await mkdtemp(join(tmpdir(), 'markdown-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'site'));
  await writeFile(join(root, 'site/index.html'), '<main></main>');
  await writeFile(join(root, 'guide.md'), [
    '# Existing heading',
    '',
    '```md',
    '# Code sample',
    '<a name="sample-anchor"></a>',
    '```',
    '<!-- <a id="hidden-anchor"></a> -->',
    '',
  ].join('\n'));
  for (const [target, diagnostic] of [
    ['#existing-heading', 'missing anchor #existing-heading in README.md'],
    ['guide.md#existing-heading-1', 'missing anchor #existing-heading-1 in guide.md'],
    ['guide.md#code-sample', 'missing anchor #code-sample in guide.md'],
    ['guide.md#sample-anchor', 'missing anchor #sample-anchor in guide.md'],
    ['guide.md#hidden-anchor', 'missing anchor #hidden-anchor in guide.md'],
  ]) {
    await writeFile(join(root, 'README.md'), `[Broken link](${target})`);
    await assert.rejects(checkLinks(root, { network: false }), { message: `README.md: ${diagnostic}` });
  }
  await rename(join(root, 'guide.md'), join(root, 'guide.source'));
  await symlink('guide.source', join(root, 'guide.md'));
  await writeFile(join(root, 'README.md'), '[Broken link](guide.md#missing)');
  await assert.rejects(checkLinks(root, { network: false }), { message: 'README.md: missing anchor #missing in guide.source' });
  await writeFile(join(root, 'README.md'), '[Broken link](#missing)');
  await rename(join(root, 'README.md'), join(root, 'README.source'));
  await symlink('README.source', join(root, 'README.md'));
  await assert.rejects(checkLinks(root, { network: false }), { message: 'README.md: missing anchor #missing in README.source' });
});

test('release links match HTML fragment values without treating markup displayed as text as anchors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'html-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'site'));
  await writeFile(join(root, 'README.md'), '# Documentation');
  const site = join(root, 'site/index.html');
  const page = [
    '<p id="100%"><a href="#100%">Percent</a></p>',
    '<p id="name%20literal"><a href="#name%20literal">Literal escape</a></p>',
    '<p id="name\\-literal"><a href="#name\\-literal">Backslash</a></p>',
    '<textarea><span id=sample-anchor>Sample</span></textarea>',
  ].join('\n');
  await writeFile(site, page);
  await checkLinks(root, { network: false });
  await writeFile(site, `${page}\n<a href="#sample-anchor">Broken jump</a>`);
  await assert.rejects(checkLinks(root, { network: false }), { message: 'site/index.html: missing anchor #sample-anchor in site/index.html' });
  await rename(site, join(root, 'site/page.html'));
  await symlink('page.html', site);
  await assert.rejects(checkLinks(root, { network: false }), { message: 'site/index.html: missing anchor #sample-anchor in site/page.html' });
});
