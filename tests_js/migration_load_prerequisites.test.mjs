import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadPrerequisites } from '../tools/migration/load-prerequisites.mjs';

test('actual Git evidence rejects working drift, uncommitted logs and symlink escapes', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'migration-proof-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repo');
  await mkdir(join(root, 'config/migration'), { recursive: true });
  await mkdir(join(root, 'docs'));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST_')));
  const git = (args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env, encoding: 'utf8' }).trim();
  git(['init', '-q']);
  const file = 'fixture.test.mjs';
  const source = "import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture', () => assert.equal(2 + 2, 4));\n";
  await writeFile(join(root, file), source);
  const command = ['node', '--test', file];
  const log = execFileSync(process.execPath, command.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  await writeFile(join(root, 'docs/proof.tap'), log);
  const environment = { id: 'local', platform: process.platform, node: process.version, unicode: process.versions.unicode };
  const contract = { id: 'compiler', kind: 'interface', requirements: ['compiler.case'], filePaths: [file],
    command, environmentId: 'local', author: 'worker', reviewer: 'reviewer' };
  await writeFile(join(root, 'config/migration/prerequisite-contracts.json'), JSON.stringify({
    schemaVersion: 1, contracts: [contract], environments: [environment],
  }));
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture evidence']);
  const head = git(['rev-parse', 'HEAD']);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const receipt = { id: 'compiler', kind: 'interface', base: head, head,
    files: [{ path: file, sha256: hash(source) }], requirements: ['compiler.case'], environment, command,
    result: { exitCode: 0, tests: 1, failures: 0, skips: 0, cancelled: 0 },
    log: { path: 'docs/proof.tap', sha256: hash(log) }, review: { author: 'worker', reviewer: 'reviewer', decision: 'approved' }, status: 'passed' };
  const save = () => writeFile(join(root, 'config/migration/prerequisite-receipts.json'), JSON.stringify({ schemaVersion: 1, receipts: [receipt] }));
  await save();
  const load = () => loadPrerequisites(root, { requirements: [], registeredTests: new Set([file]) });
  assert.deepEqual([...(await load()).acceptedInterfaces], ['compiler']);
  await writeFile(join(root, file), source + '// changed\n');
  let result = await load();
  assert.ok(result.errors.length);
  assert.equal(result.acceptedInterfaces.size, 0);
  await writeFile(join(root, file), source);
  await writeFile(join(root, 'docs/uncommitted.tap'), log);
  receipt.log.path = 'docs/uncommitted.tap';
  await save();
  assert.equal((await load()).acceptedInterfaces.size, 0);
  receipt.log.path = 'docs/proof.tap';
  await save();
  const outside = join(temporary, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'proof.tap'), log);
  await rm(join(root, 'docs'), { recursive: true });
  await symlink(outside, join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(load(), /real repository files/);
});
