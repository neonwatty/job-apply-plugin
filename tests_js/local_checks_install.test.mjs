import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, stat, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanEnvironment, git } from '../tools/local-checks/git.mjs';

const installer = fileURLToPath(new URL('../tools/local-checks/install.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'local-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await mkdir(join(root, '.githooks'));
  for (const name of ['pre-commit', 'pre-push']) {
    await writeFile(join(root, '.githooks', name), '#!/bin/sh\nexit 0\n');
  }
  return root;
}
function run(root) {
  return spawnSync(process.execPath, [installer], { cwd: root, env: cleanEnvironment(), encoding: 'utf8' });
}
function config(root, ...args) {
  return spawnSync('git', ['config', ...args], { cwd: root, env: cleanEnvironment(), encoding: 'utf8' });
}

test('installation enables executable hooks in worktree scope and is repeatable', async (t) => {
  const root = await fixture(t);
  assert.equal(run(root).status, 0);
  assert.equal(run(root).status, 0);
  assert.equal(config(root, '--worktree', '--get', 'core.hooksPath').stdout.trim(), join(await realpath(root), '.githooks'));
  assert.equal(config(root, '--local', '--get', 'core.hooksPath').status, 1);
  if (process.platform !== 'win32') assert.ok((await stat(join(root, '.githooks/pre-commit'))).mode & 0o100);
});

test('installation refuses to disable an existing default hook of any kind', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '.git/hooks/post-merge'), '#!/bin/sh\nexit 0\n');
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Existing default Git hooks/);
  assert.equal(config(root, '--get', 'core.hooksPath').status, 1);
});

test('installation preserves a configured hook directory', async (t) => {
  const root = await fixture(t);
  assert.equal(config(root, '--local', 'core.hooksPath', 'custom-hooks').status, 0);
  assert.equal(run(root).status, 1);
  assert.equal(config(root, '--get', 'core.hooksPath').stdout.trim(), 'custom-hooks');
});


const rawEvidencePath = 'docs/migration/evidence/p03/logs/P03-IV-v2-local_checks_run.tap';
const attributePath = fileURLToPath(new URL('../.gitattributes', import.meta.url));
async function whitespaceFixture(t, path, bytes) {
  const root = await fixture(t);
  const attributes = await readFile(attributePath);
  assert.equal(attributes.toString('utf8'), `/${rawEvidencePath} whitespace=-blank-at-eol\n`);
  await writeFile(join(root, '.gitattributes'), attributes);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
  git(root, ['add', '.gitattributes', path]);
  return root;
}
function checkWhitespace(root) {
  return spawnSync('git', ['-c', 'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab',
    'diff', '--cached', '--check'], { cwd: root, env: cleanEnvironment(), encoding: 'utf8' });
}

test('P03 evidence exact raw path preserves bytes and permits trailing spaces', async (t) => {
  const raw = Buffer.from('TAP version 13\n# [local-build] \nok 1 - fixed witness\n1..1\n');
  const root = await whitespaceFixture(t, rawEvidencePath, raw);
  const result = checkWhitespace(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const indexed = spawnSync('git', ['show', `:${rawEvidencePath}`], { cwd: root, env: cleanEnvironment() });
  assert.equal(indexed.status, 0);
  assert.deepEqual(indexed.stdout, raw);
  assert.equal(createHash('sha256').update(indexed.stdout).digest('hex'),
    createHash('sha256').update(raw).digest('hex'));
});

test('P03 evidence ordinary source and other log still reject trailing spaces', async (t) => {
  for (const path of ['src/example.ts', 'docs/migration/evidence/p03/logs/other.tap']) {
    const root = await whitespaceFixture(t, path, Buffer.from('fixed witness \n'));
    const result = checkWhitespace(root);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /trailing whitespace/);
  }
});

test('P03 evidence other whitespace errors at raw path still reject', async (t) => {
  for (const [bytes, diagnostic] of [['fixed witness\n\n', /new blank line at EOF/],
    [' \tfixed witness\n', /space before tab in indent/]]) {
    const root = await whitespaceFixture(t, rawEvidencePath, Buffer.from(bytes));
    const result = checkWhitespace(root);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, diagnostic);
  }
});
