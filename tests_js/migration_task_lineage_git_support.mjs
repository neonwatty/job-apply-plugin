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

export const REGISTRY = 'config/migration/packages.json';
export const B_SOURCE = 'src/b.ts';
export const B_TEST = 'tests_js/b.test.mjs';
export const PREFIX = 'docs/migration/evidence/fixture';
const doc = name => `${PREFIX}/${name}.json`;
const manifestPath = id => doc(id);
const source = id => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('${id} fixed behavior', () => assert.equal(2 + 2, 4));\nif (readFileSync(new URL('../src/${id.toLowerCase()}.ts', import.meta.url), 'utf8').includes('unexpected-result')) test('unexpected original result', () => {});\n`;
const structuralHash = pkg => digest(canonical(structuralPackage(pkg)));
const record = (id, dependencies) => ({ id, package: id.split('.')[0],
  role: id.endsWith('.V') ? 'independent-review' : 'implementation-or-gate', dependencies });

export async function lineageRepository(t, { lifecycle = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'migration-lineage-'));
  const observations = [];
  async function initial(stage) {
    if (!lifecycle) return;
    const result = await checkInventory(root); observations.push({ stage, result });
    assert.deepEqual(result.errors, [], stage);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST_')));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  const write = async (path, value) => { await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); };
  const commit = () => { git('add', '--all'); git('-c', 'user.name=Lineage Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture stage'); return git('rev-parse', 'HEAD'); };
  const lock = async () => {
    const files = [];
    for (const path of (await readdir(join(root, 'config/migration'))).sort()) if (path.endsWith('.json') && path !== 'review-lock.json') {
      files.push({ path, sha256: digest(await readFile(join(root, 'config/migration', path))) });
    }
    await write('config/migration/review-lock.json', { schemaVersion: 1, files });
  };
  git('init', '-q'); await write('.gitignore', 'node_modules/\n/node_modules\n');
  await write('package-lock.json', '{}\n'); await write('node_modules/.package-lock.json', '{}\n');
  await write(doc('oracle'), { fixture: 'fixed reference' });
  for (const id of ['A', 'B', 'C']) {
    await write(`src/${id.toLowerCase()}.ts`, `export const value = '${id}';\n`);
    await write(`tests_js/${id.toLowerCase()}.test.mjs`, source(id));
    await write(`config/migration/source-catalog-${id}.json`, { schemaVersion: 1, sources: [{ path: `src/${id.toLowerCase()}.ts`,
      sha256: digest(`export const value = '${id}';\n`), classification: 'unreviewed' }] });
  }
  await write('config/migration/nodes.json', { schemaVersion: 1, nodes: [{ id: 'G00', dependencies: [], status: 'open' }] });
  await write('config/migration/fixture-surfaces.json', { schemaVersion: 1, surfaces: [{ id: 'fixture', kind: 'document', path: 'fixture.json',
    artifact: 'json', node: 'G00', sources: ['src/a.ts', B_SOURCE], effects: 'unclassified',
    scenarios: Object.fromEntries(SCENARIOS.map(name => [name, 'unverified'])) }] });
  const requirements = ['A', 'B', 'C'].map(id => ({ id: `${id}.valid`, family: 'G00', surfaceIds: ['fixture'], category: 'valid',
    applicability: { status: 'required' }, platformCells: ['node-local'], oracleFiles: [{ path: doc('oracle'),
      sha256: digest(JSON.stringify({ fixture: 'fixed reference' }, null, 2) + '\n') }],
    testBindings: [{ suiteId: id, file: `tests_js/${id.toLowerCase()}.test.mjs`, testId: `${id} fixed behavior`,
      command: ['node', '--test', `tests_js/${id.toLowerCase()}.test.mjs`], timeoutMs: 10000, maxOutputBytes: 100000 }],
    expectedArtifacts: [`evidence/${id}.json`] }));
  await write('config/migration/requirements-fixture.json', { schemaVersion: 1, requirements });
  await write('config/test-matrix.json', { schemaVersion: 1, suites: ['A', 'B', 'C'].map(id => ({ id, kind: 'node-test',
    include: [`tests_js/${id.toLowerCase()}.test.mjs`], tiers: ['full'] })) });
  const packages = ['A', 'B', 'C'].map(id => ({ id, parentNode: 'G00', owner: `${id}-author`,
    allowed_files: [`src/${id.toLowerCase()}.ts`, `tests_js/${id.toLowerCase()}.test.mjs`, `config/migration/source-catalog-${id}.json`,
      ...(id === 'B' ? [REGISTRY] : []), manifestPath(`${id}.I`), manifestPath(`${id}.V`)],
    surfaceIds: ['fixture'], requirementIds: [`${id}.valid`], dependencies: id === 'C' ? ['B'] : [],
    interfaceIds: ['fixture-interface'], referenceIds: [`${id}-reference`], emittedFiles: [], activation: 'inert', status: 'planned' }));
  const savePackages = () => write(REGISTRY, { schemaVersion: 1, packages });
  await savePackages();
  const dag = [record('A.I', []), record('A.V', ['A.I']), record('B.I', ['A.V']), record('B.V', ['B.I']), record('C.I', ['B.V']), record('C.V', ['C.I'])];
  await write(doc('dag-original'), dag);
  const contracts = requirements.map(item => ({ id: `${item.id[0]}-reference`, kind: 'reference', requirements: [item.id], filePaths: [item.testBindings[0].file],
    command: item.testBindings[0].command, environmentId: environment.id, author: 'oracle-author', reviewer: 'oracle-reviewer' }));
  contracts.push({ id: 'fixture-interface', kind: 'interface', requirements: ['fixture.interface'], filePaths: ['tests_js/a.test.mjs'],
    command: ['node', '--test', 'tests_js/a.test.mjs'], environmentId: environment.id, author: 'oracle-author', reviewer: 'oracle-reviewer' });
  await write('config/migration/prerequisite-contracts.json', { schemaVersion: 1, contracts, environments: [environment] });
  const referenceLogs = new Map();
  for (const contract of contracts) {
    const log = execFileSync(process.execPath, contract.command.slice(1), { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    const path = `evidence/${contract.id}.tap`; await write(path, log); referenceLogs.set(contract.id, { path, sha256: digest(log) });
  }
  await lock(); const referenceBase = commit(); await initial('prerequisite-planning');
  const io = await createEvidenceIO(root);
  const binding = (path, revision = git('rev-parse', 'HEAD')) => ({ path, sha256: digest(io.fileAt(revision, path)), revision });
  const prerequisites = contracts.map(contract => ({ id: contract.id, kind: contract.kind, base: referenceBase, head: referenceBase,
    files: contract.filePaths.map(path => ({ path, sha256: digest(io.fileAt(referenceBase, path)) })), requirements: contract.requirements,
    environment, command: contract.command, result: { exitCode: 0, tests: 1, failures: 0, skips: 0, cancelled: 0 }, log: referenceLogs.get(contract.id),
    review: { author: contract.author, reviewer: contract.reviewer, decision: 'approved' }, status: 'passed' }));
  await write('config/migration/prerequisite-receipts.json', { schemaVersion: 1, receipts: prerequisites }); await lock(); commit(); await initial('prerequisite-receipts');
  packages[0].status = 'ready'; await savePackages(); await lock(); commit(); await initial('A-ready');
  const catalog = { schemaVersion: 1, dag: binding(doc('dag-original'), referenceBase), assignments: [], environments: [environment], audits: [] };
  const lineage = { schemaVersion: 1, preparations: [], transitions: [] };
  const receipts = [];
  let currentDag = dag, currentDagBinding = catalog.dag;
  async function check() { return checkInventory(root); }
  async function observe(stage) {
    if (!lifecycle) return null;
    git('add', '--all'); const before = [git('rev-parse', 'HEAD'), git('write-tree'), git('status', '--porcelain')];
    const revision = git('-c', 'user.name=Lineage Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', before[1], '-p', before[0], '-m', 'snapshot');
    const result = await withSnapshot(root, revision, async path => {
      assert.equal(await realpath(join(path, 'node_modules')), await realpath(join(root, 'node_modules')));
      return checkInventory(path);
    }, { dependencies: true });
    assert.deepEqual([git('rev-parse', 'HEAD'), git('write-tree'), git('status', '--porcelain')], before);
    observations.push({ stage, result }); assert.deepEqual(result.errors, [], stage); return result;
  }
  function makeManifest(task, pkg, base, dagBinding, logPath) {
    const paths = [...pkg.allowed_files, ...(pkg.id === 'B' ? ['config/migration/task-contracts.json', 'config/migration/review-lock.json'] : [])];
    return { schemaVersion: 1, id: task.id, role: task.role, kind: 'package', dag: { path: dagBinding.path, sha256: dagBinding.sha256 },
      package: clone(pkg), packageSha256: structuralHash(pkg), auditContract: null, author: pkg.owner, reviewer: `${pkg.id}-reviewer`, base,
      inputs: paths.filter(path => io.fileAt(base, path) !== null).map(path => ({ path, sha256: digest(io.fileAt(base, path)) })),
      oversized: [], cells: [{ id: `${pkg.id}-cell`, requirementIds: pkg.requirementIds, environmentId: environment.id,
        reporter: 'node-tap13', command: ['node', '--test', `tests_js/${pkg.id.toLowerCase()}.test.mjs`], testNames: [`${pkg.id} fixed behavior`],
        timeoutMs: 10000, maxOutputBytes: 100000, logPath }], artifacts: [`evidence/${pkg.id}.json`] };
  }
  async function freezeOriginal(id = 'B', { archived = false } = {}) {
    const pkg = packages.find(item => item.id === id), base = git('rev-parse', 'HEAD');
    const manifests = (archived ? dag : currentDag).filter(item => item.package === id && !item.id.includes('retry')).map(task => makeManifest(task, pkg, base, archived ? catalog.dag : currentDagBinding, `evidence/${id}.tap`));
    for (const manifest of manifests) await write(manifestPath(manifest.id), manifest);
    await observe(`${id}-planning`); const planning = commit();
    for (const manifest of manifests) catalog.assignments.push({ id: manifest.id, author: manifest.author, reviewer: manifest.reviewer,
      manifest: binding(manifestPath(manifest.id), planning) });
    await write('config/migration/task-contracts.json', catalog); await lock();
    await observe(`${id}-activation`); const executionBase = commit();
    return { id, pkg, manifests, base, planning, executionBase, nextDag: currentDag };
  }
  async function implement(task, { mismatch = false } = {}) {
    task.pkg = packages.find(item => item.id === task.id);
    if (task.id === 'B') { task.pkg.status = task.key ? 'implemented' : 'ready'; await savePackages(); }
    const path = `src/${task.id.toLowerCase()}.ts`;
    const bytes = `export const value = '${task.id}';\n` + (mismatch ? '// unexpected-result\n' : '');
    await write(path, bytes);
    await write(`config/migration/source-catalog-${task.id}.json`, { schemaVersion: 1,
      sources: [{ path, sha256: digest(bytes), classification: 'unreviewed' }] });
    await lock(); await observe(`${task.key ?? task.id}-subject`); task.subject = commit(); return task;
  }
  async function capture(task, { diagnostic = null } = {}) {
    const manifest = task.manifests[0], start = performance.now();
    const log = await withSnapshot(root, task.subject, path => execFileSync(process.execPath, manifest.cells[0].command.slice(1),
      { cwd: path, env, encoding: 'utf8', timeout: 10000 }), { dependencies: true });
    task.durationMs = performance.now() - start; task.log = log;
    await write(manifest.cells[0].logPath, log); await write(manifest.artifacts[0], '{}\n');
    await observe(`${task.key ?? task.id}-evidence`); task.evidence = commit();
    task.capture = { schemaVersion: 1, id: `${task.key ?? task.id}-capture`, subject: { sha: task.subject, tree: io.tree(task.subject) },
      executionBase: task.executionBase, attributions: [{ taskId: manifest.id, manifestSha256: digest(io.fileAt(task.planning, manifestPath(manifest.id))), cellIds: [manifest.cells[0].id] }],
      cells: [{ id: manifest.cells[0].id, command: manifest.cells[0].command, environmentId: environment.id, environment,
        result: { exitCode: 0, signal: null, timedOut: false, durationMs: task.durationMs, outputBytes: Buffer.byteLength(log) },
        log: { path: manifest.cells[0].logPath, sha256: digest(log) }, artifacts: [{ path: manifest.artifacts[0], sha256: digest('{}\n') }], diagnostic }] };
    return task;
  }
  async function prepare(id, documents) {
    const files = [];
    for (const [path, value] of documents) { await write(path, value); files.push({ path, sha256: digest(await readFile(join(root, path))) }); }
    lineage.preparations.push({ id, author: 'root', reviewer: 'hooks_audit', reason: 'Exact fixture planning documents', files });
    await write('config/migration/task-lineage.json', lineage); await lock();
    await observe(id); return commit();
  }
  async function freezeReplacement(original, { key = 'B.retry1', mutate = () => {}, changeDag = () => {}, changeManifests = () => {}, changePackage = () => {}, changeRegistry = () => {} } = {}) {
    let captureBinding = null;
    if (original.capture) {
      const path = doc(`${key}-original-capture`);
      const revision = await prepare(`${key}-capture-preparation`, [[path, original.capture]]);
      captureBinding = { path, sha256: digest(io.fileAt(revision, path)) };
    }
    const base = git('rev-parse', 'HEAD'), nextDag = clone(original.nextDag ?? dag);
    const priorReview = original.manifests[1].id;
    nextDag.push(record(`${key}.I`, ['A.V']), record(`${key}.V`, [`${key}.I`]));
    nextDag.find(task => task.id === 'C.I').dependencies = [`${key}.V`];
    changeDag(nextDag);
    const newPaths = [manifestPath(`${key}.I`), manifestPath(`${key}.V`), `tests_js/${key}-support.mjs`];
    const pkg = { ...clone(original.pkg), status: packages.find(item => item.id === original.id).status, allowed_files: [...original.pkg.allowed_files, ...newPaths] };
    changePackage(pkg);
    const dagPath = doc(`${key}-dag`), dagBytes = JSON.stringify(nextDag, null, 2) + '\n';
    const dagBinding = { path: dagPath, sha256: digest(dagBytes) };
    const manifests = nextDag.filter(task => task.id.startsWith(`${key}.`)).map(task => makeManifest(task, pkg, base, dagBinding, `evidence/${key}.tap`));
    if (captureBinding) for (const manifest of manifests) manifest.inputs.push(captureBinding);
    changeManifests(manifests);
    const documents = [[dagPath, dagBytes], ...manifests.map(manifest => [manifestPath(manifest.id), manifest])];
    const planning = await prepare(`${key}-documents`, documents);
    const nextPackages = packages.map(item => clone(item.id === 'B' ? pkg : item));
    changeRegistry(nextPackages);
    const nextRegistry = JSON.stringify({ schemaVersion: 1, packages: nextPackages }, null, 2) + '\n';
    const artifactBindings = original.capture ? [...new Set(original.manifests.flatMap(item => [...item.cells.map(cell => cell.logPath), ...item.artifacts]))]
      .filter(path => io.fileAt(original.evidence, path) !== null).map(path => ({ path, sha256: digest(io.fileAt(original.evidence, path)) })) : [];
    const attempt = original.capture ? { subject: original.capture.subject, evidenceCommit: original.evidence, capture: captureBinding,
      files: original.pkg.allowed_files.map(path => ({ path, sha256: io.fileAt(original.subject, path) === null ? null : digest(io.fileAt(original.subject, path)) })),
      artifacts: artifactBindings } : null;
    const transition = { schemaVersion: 1, id: `${key}-transition`, previousDag: original.key ? original.transition.nextDag : catalog.dag, nextDag: binding(dagPath, planning),
      retirements: original.manifests.map((manifest, index) => ({ id: manifest.id, manifest: binding(manifestPath(manifest.id), original.planning),
        replacementId: `${key}.${index === 0 ? 'I' : 'V'}`, attempt: index === 0 ? attempt : null })),
      additions: manifests.map(manifest => ({ id: manifest.id, manifest: binding(manifestPath(manifest.id), planning) })),
      refinements: [{ id: 'C.I', beforeDependencies: [priorReview], afterDependencies: [`${key}.V`] }],
      packageVersions: [{ packageId: 'B', originalTaskIds: original.manifests.map(item => item.id), replacementTaskIds: [`${key}.I`, `${key}.V`],
        previous: { packageSha256: original.manifests[0].packageSha256, registry: binding(REGISTRY, original.key ? original.executionBase : original.planning) },
        next: { packageSha256: structuralHash(pkg), registry: { path: REGISTRY, sha256: digest(nextRegistry) } },
        additions: { allowed_files: newPaths, emittedFiles: [] } }],
      witnessMappings: original.manifests.map((manifest, index) => ({ originalTaskId: manifest.id, replacementTaskId: manifests[index].id,
        originalCellId: manifest.cells[0].id, replacementCellId: manifests[index].cells[0].id })),
      author: 'root', reviewer: 'hooks_audit', decision: 'approved', reason: 'Preserve original attempt and explicitly replace its contract' };
    mutate(transition);
    const transitionPath = doc(`${key}-transition`), revision = await prepare(`${key}-transition-document`, [[transitionPath, transition]]);
    return { id: 'B', key, pkg, manifests, base, planning, original, nextDag, nextRegistry, transition, transitionBinding: binding(transitionPath, revision), newPaths };
  }
  async function activateReplacement(next) {
    lineage.transitions.push(next.transitionBinding);
    currentDag = next.nextDag; currentDagBinding = next.transition.nextDag;
    for (const manifest of next.manifests) catalog.assignments.push({ id: manifest.id, author: manifest.author, reviewer: manifest.reviewer,
      manifest: binding(manifestPath(manifest.id), next.planning) });
    packages[1] = next.pkg;
    await write(REGISTRY, next.nextRegistry); await write('config/migration/task-contracts.json', catalog);
    await write('config/migration/task-lineage.json', lineage); await lock();
    await observe(`${next.key}-activation`); next.executionBase = commit(); return next;
  }
  async function publish(task, { mutate = () => {} } = {}) {
    for (const manifest of task.manifests) {
      const manifestSha256 = digest(io.fileAt(task.planning, manifestPath(manifest.id)));
      const assignment = (task.nextDag ?? dag).find(item => item.id === manifest.id);
      const dependencies = assignment.dependencies.map(id => ({ id, sha256: digest(canonical(receipts.find(value => value.id === id))) }));
      receipts.push({ schemaVersion: 1, id: manifest.id, manifestSha256, subject: { sha: task.subject, tree: io.tree(task.subject) },
        executionBase: task.executionBase, evidenceCommit: task.evidence, diff: io.diff(task.executionBase, task.subject),
        files: manifest.package.allowed_files.map(path => ({ path, sha256: io.fileAt(task.subject, path) === null ? null : digest(io.fileAt(task.subject, path)) })), dependencies,
        cells: [{ id: manifest.cells[0].id, environment, command: manifest.cells[0].command,
          result: { exitCode: 0, timedOut: false, durationMs: task.durationMs, outputBytes: Buffer.byteLength(task.log), tests: 1, failures: 0, skips: 0, cancelled: 0, todo: 0 },
          log: { path: manifest.cells[0].logPath, sha256: digest(task.log) } }], artifacts: [{ path: manifest.artifacts[0], sha256: digest('{}\n') }],
        review: { author: manifest.author, reviewer: manifest.reviewer, subjectSha: task.subject, subjectTree: io.tree(task.subject), manifestSha256, decision: 'approved' }, status: 'passed' });
      mutate(receipts.at(-1), manifest);
    }
    await write('config/migration/task-receipts.json', { schemaVersion: 1, receipts }); await lock();
    const result = await observe(`${task.key ?? task.id}-receipts`); git('add', '--all'); const tree = git('write-tree'); commit();
    assert.equal(git('rev-parse', 'HEAD^{tree}'), tree); return result ?? check();
  }
  async function implementReplacement(next) {
    await write(next.newPaths.at(-1), 'export const witness = true;\n'); return implement(next);
  }
  const a = await freezeOriginal('A'); await implement(a); await capture(a); const accepted = await publish(a);
  assert.deepEqual(accepted.errors, []); assert.ok(accepted.taskEvidence.acceptedPackages.includes('A'));
  const acceptedHistory = canonical(receipts);
  const checkpoint = () => ({ revision: git('rev-parse', 'HEAD'), catalog: clone(catalog), lineage: clone(lineage), packages: clone(packages), receipts: clone(receipts), currentDag: clone(currentDag), currentDagBinding: clone(currentDagBinding) });
  function restore(point) { currentDag = clone(point.currentDag); currentDagBinding = clone(point.currentDagBinding); git('reset', '--hard', point.revision); git('clean', '-fd');
    for (const [target, value] of [[catalog, point.catalog], [lineage, point.lineage]]) { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, clone(value)); }
    packages.splice(0, packages.length, ...clone(point.packages)); receipts.splice(0, receipts.length, ...clone(point.receipts)); }
  async function mergePrepared(left) {
    const preparations = [...left.lineage.preparations, ...lineage.preparations]
      .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
    try { git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--no-ff', '--no-commit', left.revision); }
    catch (error) { if (!git('diff', '--name-only', '--diff-filter=U')) throw error; }
    lineage.preparations = preparations;
    await write('config/migration/task-lineage.json', lineage); await lock(); commit();
  }
  return { root, git, write, commit, lock, io, binding, check, observe, prepare, freezeOriginal, implement, capture, freezeReplacement,
    activateReplacement, implementReplacement, publish, packages, catalog, lineage, receipts, observations, acceptedHistory, checkpoint, restore, mergePrepared };
}
