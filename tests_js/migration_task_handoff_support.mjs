import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical, createEvidenceIO, digest } from '../tools/migration/evidence-io.mjs';
import { structuralPackage } from '../tools/migration/task-manifests.mjs';
import { checkInventory, SCENARIOS } from '../tools/migration/check.mjs';
import { withSnapshot } from '../tools/local-checks/git.mjs';
import { environment, clone } from './migration_task_support.mjs';

export const SHARED = 'src/shared.ts';
export const RESERVED = 'src/reserved.ts';
export const CATALOG = 'config/migration/source-catalog-product.json';
export const PACKAGES = 'config/migration/packages.json';
export const TEST = 'tests_js/product.test.mjs';
export const ORACLE = 'tests_js/oracle.test.mjs';
const testSource = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('product fixed behavior', () => assert.equal(1 + 1, 2));\n";
const oracleSource = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('oracle fixed behavior', () => assert.equal(2 + 2, 4));\n";
const assignment = (id, packageId, dependencies) => ({ id, package: packageId,
  role: id.endsWith('.V') ? 'independent-review' : 'implementation-or-gate', dependencies });
const manifestPath = id => `docs/tasks/${id}.json`;
const requirement = id => `${id.toLowerCase()}.valid`;

export async function productRepository(t, { lifecycle = false, competing = false } = {}) {
  const observations = [];
  const root = await mkdtemp(join(tmpdir(), 'migration-product-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST_')));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  const write = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Product Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture stage');
    return git('rev-parse', 'HEAD');
  };
  const writeLock = async () => {
    const files = [];
    for (const path of (await readdir(join(root, 'config/migration'))).sort()) {
      if (path.endsWith('.json') && path !== 'review-lock.json') files.push({ path,
        sha256: digest(await readFile(join(root, 'config/migration', path))) });
    }
    await write('config/migration/review-lock.json', { schemaVersion: 1, files });
  };
  const reconcile = async () => write(CATALOG, { schemaVersion: 1, sources: [{ path: SHARED,
    sha256: digest(await readFile(join(root, SHARED))), classification: 'unreviewed' }] });
  git('init', '-q');
  await write('.gitignore', 'node_modules/\n/node_modules\n');
  await write('package-lock.json', '{}\n');
  await write('node_modules/.package-lock.json', '{}\n');
  await write(SHARED, 'export const value = 0;\n');
  await write('src/parallel.ts', 'export const parallel = 0;\n');
  await write('config/migration/source-catalog-parallel.json', { schemaVersion: 1, sources: [{ path: 'src/parallel.ts', sha256: digest('export const parallel = 0;\n'), classification: 'unreviewed' }] });
  await write('src/third.ts', 'export const third = true;\n');
  await write('config/migration/source-catalog-third.json', { schemaVersion: 1, sources: [{ path: 'src/third.ts', sha256: digest('export const third = true;\n'), classification: 'unreviewed' }] });
  await write(RESERVED, 'export const reserved = true;\n');
  await write(TEST, testSource); await write(ORACLE, oracleSource);
  await write('docs/oracle.json', { fixture: 'independent product contract' });
  await write('config/test-matrix.json', { schemaVersion: 1, suites: [
    { id: 'product', kind: 'node-test', include: [TEST], tiers: ['full'] },
    { id: 'oracle', kind: 'node-test', include: [ORACLE], tiers: ['full'] },
  ] });
  await write('config/migration/nodes.json', { schemaVersion: 1, nodes: [{ id: 'G00', dependencies: [], status: 'open' }] });
  await reconcile();
  await write('config/migration/source-catalog-reserved.json', { schemaVersion: 1, sources: [{ path: RESERVED,
    sha256: digest(await readFile(join(root, RESERVED))), classification: 'unreviewed' }] });
  await write('config/migration/product-surfaces.json', { schemaVersion: 1, surfaces: [{ id: 'product-document',
    kind: 'document', path: 'synthetic.json', artifact: 'json', node: 'G00', sources: [SHARED, RESERVED],
    effects: 'unclassified', scenarios: Object.fromEntries(SCENARIOS.map(name => [name, 'unverified'])) }] });
  const requirements = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id: requirement(id), surfaceIds: ['product-document'],
    family: 'G00', category: 'valid', applicability: { status: 'required' }, platformCells: ['node-local'],
    oracleFiles: [{ path: 'docs/oracle.json', sha256: digest(JSON.stringify({ fixture: 'independent product contract' }, null, 2) + '\n') }],
    testBindings: [{ suiteId: 'product', file: TEST, testId: 'product fixed behavior', command: ['node', '--test', TEST],
      timeoutMs: 10000, maxOutputBytes: 100000 }], expectedArtifacts: [`evidence/${id}.json`] }));
  await write('config/migration/requirements-product.json', { schemaVersion: 1, requirements });
  const packages = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, parentNode: 'G00', owner: `${id}-author`,
    allowed_files: [...(id === 'E' ? ['src/parallel.ts', 'config/migration/source-catalog-parallel.json'] : id === 'C' && !competing ? ['src/third.ts'] : [SHARED, CATALOG, PACKAGES, ...(id === 'A' ? [RESERVED] : [])]), manifestPath(`${id}.I`), manifestPath(`${id}.V`)],
    surfaceIds: ['product-document'], requirementIds: [requirement(id)], dependencies: ['A', 'E'].includes(id) ? [] : [id === 'D' ? 'B' : 'A'],
    interfaceIds: ['fixture-interface'], referenceIds: ['fixture-reference'], emittedFiles: [], activation: 'inert', status: 'planned' }));
  // An unactivated planned package reserves no running ownership; activate one explicitly.
  const savePackages = () => write('config/migration/packages.json', { schemaVersion: 1, packages });
  await savePackages();
  const dag = [assignment('A.I', 'A', []), assignment('A.V', 'A', ['A.I']),
    assignment('B.I', 'B', ['A.V']), assignment('B.V', 'B', ['B.I']),
    assignment('C.I', 'C', ['A.V']), assignment('C.V', 'C', ['C.I']),
    assignment('D.I', 'D', ['B.V']), assignment('D.V', 'D', ['D.I']), assignment('E.I', 'E', []), assignment('E.V', 'E', ['E.I'])];
  await write('docs/dag.json', dag);
  const contracts = ['interface', 'reference'].map(kind => ({ id: `fixture-${kind}`, kind,
    requirements: kind === 'reference' ? requirements.map(item => item.id) : ['fixture.interface'],
    filePaths: [TEST], command: ['node', '--test', TEST], environmentId: environment.id,
    author: 'oracle-author', reviewer: 'oracle-reviewer' }));
  await write('config/migration/prerequisite-contracts.json', { schemaVersion: 1, contracts, environments: [environment] });
  const oracleLog = execFileSync(process.execPath, ['--test', TEST], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  await write('evidence/oracle.tap', oracleLog); await writeLock();
  const baseline = commit();
  if (lifecycle) observations.push({ stage: 'prerequisite-planning', result: await checkInventory(root) });
  const prerequisiteReceipts = contracts.map(contract => ({ id: contract.id, kind: contract.kind,
    base: baseline, head: baseline, files: [{ path: TEST, sha256: digest(testSource) }], requirements: contract.requirements,
    environment, command: contract.command, result: { exitCode: 0, tests: 1, failures: 0, skips: 0, cancelled: 0 },
    log: { path: 'evidence/oracle.tap', sha256: digest(oracleLog) },
    review: { author: contract.author, reviewer: contract.reviewer, decision: 'approved' }, status: 'passed' }));
  await write('config/migration/prerequisite-receipts.json', { schemaVersion: 1, receipts: prerequisiteReceipts });
  await writeLock(); commit();
  if (lifecycle) observations.push({ stage: 'prerequisite-receipt', result: await checkInventory(root) });
  packages.find(item => item.id === 'E').status = 'ready';
  await savePackages(); await writeLock(); commit();
  if (lifecycle) observations.push({ stage: 'independent-package-ready', result: await checkInventory(root) });
  const io = await createEvidenceIO(root);
  const catalog = { schemaVersion: 1, dag: { path: 'docs/dag.json', sha256: digest(io.fileAt(baseline, 'docs/dag.json')), revision: baseline },
    assignments: [], environments: [environment], audits: [] };
  const receipts = [], handoffs = [];
  const beforeSnapshot = () => ({ head: git('rev-parse', 'HEAD'), index: git('write-tree'), status: git('status', '--porcelain') });
  async function check(snapshot = false) {
    if (!snapshot) return checkInventory(root);
    const before = beforeSnapshot();
    const revision = git('-c', 'user.name=Product Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit-tree', before.index, '-p', before.head, '-m', 'owned staged snapshot');
    const result = await withSnapshot(root, revision, async path => {
      assert.equal(await realpath(join(path, 'node_modules')), await realpath(join(root, 'node_modules')));
      return checkInventory(path);
    }, { dependencies: true });
    assert.deepEqual(beforeSnapshot(), before, 'snapshot must not change root HEAD, index or status');
    return result;
  }
  async function observe(stage) {
    if (!lifecycle) return null;
    git('add', '--all');
    const result = await check(true); observations.push({ stage, result });
    assert.deepEqual(result.errors, [], stage); return result;
  }
  async function freeze(id, { extraPaths = [] } = {}) {
    const pkg = packages.find(item => item.id === id);
    if (id !== 'E') pkg.status = 'planned';
    for (const path of extraPaths) if (!pkg.allowed_files.includes(path)) pkg.allowed_files.push(path);
    await savePackages(); await writeLock();
    await observe(`${id}-preparation`);
    const base = commit();
    const inputs = [...pkg.allowed_files, TEST, 'config/migration/task-contracts.json', 'config/migration/review-lock.json'];
    const manifests = [];
    for (const suffix of ['I', 'V']) {
      const task = dag.find(item => item.id === `${id}.${suffix}`);
      const manifest = { schemaVersion: 1, id: task.id, role: task.role, kind: 'package', dag: catalog.dag,
        package: clone(pkg), packageSha256: digest(canonical(structuralPackage(pkg))), auditContract: null,
        author: pkg.owner, reviewer: `${id}-reviewer`, base,
        inputs: inputs.filter(path => git('ls-tree', '--name-only', base, path)).map(path => ({ path, sha256: digest(io.fileAt(base, path)) })),
        oversized: [], cells: [{ id: `${id}-product`, requirementIds: pkg.requirementIds, environmentId: environment.id,
          reporter: 'node-tap13', command: ['node', '--test', TEST], testNames: ['product fixed behavior'],
          timeoutMs: 10000, maxOutputBytes: 100000, logPath: `evidence/${id}.tap` }], artifacts: [`evidence/${id}.json`] };
      // Manifest DAG binding omits the catalog's revision field.
      manifest.dag = { path: catalog.dag.path, sha256: catalog.dag.sha256 };
      await write(manifestPath(task.id), manifest); manifests.push(manifest);
    }
    await observe(`${id}-planning`);
    const planning = commit();
    for (const manifest of manifests) catalog.assignments.push({ id: manifest.id, author: manifest.author,
      reviewer: manifest.reviewer, manifest: { path: manifestPath(manifest.id), sha256: digest(io.fileAt(planning, manifestPath(manifest.id))), revision: planning } });
    return { id, pkg, manifests, base, planning, executionBase: null };
  }
  async function activate(next) {
    await write('config/migration/task-contracts.json', catalog);
    if (handoffs.length) await write('config/migration/task-handoffs.json', { schemaVersion: 1, handoffs });
    await writeLock();
    await observe(`${next.id}-activation`); next.executionBase = commit(); return next;
  }
  async function authorize(next, { predecessor = 'A', mutate = () => {} } = {}) {
    const pred = packages.find(item => item.id === predecessor), manifest = next.manifests[0];
    const predReceipt = receipts.find(item => item.id === `${predecessor}.V`);
    const contract = { schemaVersion: 1, id: `${predecessor}-to-${next.id}`,
      predecessorPackageId: predecessor, predecessorPackageSha256: digest(canonical(structuralPackage(pred))),
      predecessorReviewTaskId: `${predecessor}.V`, predecessorReceiptSha256: digest(canonical(predReceipt)),
      successorPackageId: next.id, successorPackageSha256: manifest.packageSha256,
      successorTaskId: manifest.id, successorManifestSha256: digest(io.fileAt(next.planning, manifestPath(manifest.id))),
      paths: [SHARED, CATALOG, PACKAGES].map(path => ({ path, sha256: digest(io.fileAt(predReceipt.subject.sha, path)) })),
      author: manifest.author, reviewer: manifest.reviewer, decision: 'approved' };
    mutate(contract);
    const path = `docs/handoffs/${contract.id}.json`;
    await write(path, contract); await writeLock();
    await observe(`${next.id}-handoff-planning`); const revision = commit();
    handoffs.push({ path, sha256: digest(io.fileAt(revision, path)), revision });
    return contract;
  }
  async function implement(next, { changeSource = true } = {}) {
    if (next.id === 'E') {
      const path = 'src/parallel.ts';
      await write(path, `export const parallel = 'E';\n`);
      await write('config/migration/source-catalog-parallel.json', { schemaVersion: 1, sources: [{ path, sha256: digest(await readFile(join(root, path))), classification: 'unreviewed' }] });
    } else {
      next.pkg.status = 'implemented'; await savePackages();
      if (changeSource) await write(SHARED, `export const value = '${next.id}';\n`);
      await reconcile();
    }
    await writeLock();
    await observe(`${next.id}-subject`); next.subject = commit(); return next;
  }
  async function complete(next, { publish = true } = {}) {
    const subject = next.subject ?? git('rev-parse', 'HEAD');
    const start = performance.now();
    const log = await withSnapshot(root, subject, path => execFileSync(process.execPath, ['--test', TEST],
      { cwd: path, env, encoding: 'utf8', timeout: 10000 }), { dependencies: true });
    const durationMs = performance.now() - start;
    await write(`evidence/${next.id}.tap`, log); await write(`evidence/${next.id}.json`, '{}\n');
    await observe(`${next.id}-evidence`); const evidenceCommit = commit();
    for (const manifest of next.manifests) {
      const manifestSha256 = digest(io.fileAt(next.planning, manifestPath(manifest.id)));
      const dependencies = dag.find(item => item.id === manifest.id).dependencies.map(id => {
        const value = receipts.find(receipt => receipt.id === id); assert.ok(value, `Missing actual predecessor ${id}`);
        return { id, sha256: digest(canonical(value)) };
      });
      receipts.push({ schemaVersion: 1, id: manifest.id, manifestSha256, subject: { sha: subject, tree: io.tree(subject) },
        executionBase: next.executionBase, evidenceCommit, diff: io.diff(next.executionBase, subject),
        files: manifest.package.allowed_files.map(path => ({ path, sha256: digest(io.fileAt(subject, path)) })), dependencies,
        cells: [{ id: manifest.cells[0].id, environment, command: manifest.cells[0].command,
          result: { exitCode: 0, timedOut: false, durationMs, outputBytes: Buffer.byteLength(log), tests: 1, failures: 0, skips: 0, cancelled: 0, todo: 0 },
          log: { path: manifest.cells[0].logPath, sha256: digest(log) } }],
        artifacts: [{ path: manifest.artifacts[0], sha256: digest('{}\n') }],
        review: { author: manifest.author, reviewer: manifest.reviewer, subjectSha: subject, subjectTree: io.tree(subject), manifestSha256, decision: 'approved' }, status: 'passed' });
    }
    if (!publish) return null;
    await write('config/migration/task-receipts.json', { schemaVersion: 1, receipts }); await writeLock();
    const observed = await observe(`${next.id}-receipt`);
    git('add', '--all'); const testedTree = git('write-tree'); commit();
    assert.equal(git('rev-parse', 'HEAD^{tree}'), testedTree);
    return observed ?? check();
  }
  const checkpoint = () => git('rev-parse', 'HEAD');
  const restore = revision => { git('reset', '--hard', revision); git('clean', '-fd'); };
  return { root, git, write, commit, writeLock, reconcile, freeze, activate, authorize, implement, complete,
    check, observe, observations, packages, catalog, receipts, handoffs, checkpoint, restore, savePackages };
}

export async function acceptedProduct(t, options) {
  const repo = await productRepository(t, options);
  const first = await repo.freeze('A'); await repo.activate(first); await repo.implement(first);
  const result = await repo.complete(first);
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  assert.ok(result.taskEvidence.acceptedPackages.includes('A'));
  return repo;
}
export function noAcceptance(result) {
  assert.ok(['open', 'invalid'].includes(result.taskEvidence.currentAcceptance));
  assert.deepEqual(result.taskEvidence.acceptedPackages, []);
  assert.deepEqual(result.taskEvidence.acceptedTasks, []);
}
