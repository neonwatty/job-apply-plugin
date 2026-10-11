import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCodexModelArguments, cleanCodexRevision, runCodexModelCli } from '../evals/workflows/codex-model-cli.mjs';

const execute = promisify(execFile);
const paths = { binary: resolve('/native/codex'), authHome: resolve('/auth'), outputDirectory: resolve('/new/evidence') };
const flags = ['--binary', paths.binary, '--auth-home', paths.authHome, '--output', paths.outputDirectory];

test('Codex trial CLI has closed explicit arguments and bounded defaults', () => {
  assert.deepEqual(parseCodexModelArguments(flags), { mode: 'trials', ...paths, trials: 3, maxTurns: 12 });
  const result = parseCodexModelArguments([...flags, '--trials', '5', '--max-turns', '20']);
  assert.equal(result.trials, 5); assert.equal(result.maxTurns, 20);
  assert.deepEqual(parseCodexModelArguments(['--readiness', '--binary', '/native/codex']), {
    mode: 'readiness', binary: '/native/codex' });
});

test('CLI rejects unknown, duplicate, ambiguous and mixed readiness options before runtime execution', async () => {
  for (const args of [[], ['--binary', 'codex'], ['--binary', '/native/codex'],
    [...flags, '--model', 'other'], [...flags, '--binary', '/other'], [...flags, '--readiness'],
    [...flags, '--trials', '0'], [...flags, '--trials', '6'], [...flags, '--trials', '1.5'],
    [...flags, '--trials', '01'], [...flags, '--max-turns', '21'], [...flags, '--max-turns'],
    ['--readiness', '--readiness', '--binary', '/native/codex']]) {
    assert.throws(() => parseCodexModelArguments(args));
    const result = await runCodexModelCli(args);
    assert.equal(result.code, 2); assert.equal(result.report.ready, false);
  }
});

test('exact revision gate rejects tracked edits, untracked files and changed HEAD', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-cli-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execute('git', ['-C', root, ...args]);
  await git(['init', '--quiet']);
  await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'tracked'), 'initial\n'); await git(['add', 'tracked']);
  await git(['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Fixture initial state']);
  const revision = await cleanCodexRevision(root);
  assert.match(revision, /^[a-f0-9]{40}$/);
  await assert.rejects(cleanCodexRevision(root, 'f'.repeat(40)), /revision_changed/);
  await writeFile(join(root, 'untracked'), 'new');
  await assert.rejects(cleanCodexRevision(root, revision), /dirty_checkout/);
  await rm(join(root, 'untracked')); await writeFile(join(root, 'tracked'), 'changed\n');
  await assert.rejects(cleanCodexRevision(root, revision), /dirty_checkout/);
});
