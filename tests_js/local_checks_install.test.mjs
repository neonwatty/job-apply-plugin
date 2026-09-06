import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
