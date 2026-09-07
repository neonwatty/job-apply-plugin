import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, createEvidenceIO, digest, physicalLines } from '../tools/migration/evidence-io.mjs';
import { structuralPackage } from '../tools/migration/task-manifests.mjs';

export const clone = value => structuredClone(value);
export const TEST = 'tests_js/audit.test.mjs';
export const MANIFEST = 'config/migration/tasks/T01.I.json';
export const source = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('audit exact input', () => { assert.equal(1 + 1, 2); });\n";
export const environment = { id: 'node-local', platform: process.platform, node: process.version, unicode: process.versions.unicode };
export const assignment = { id: 'T01.I', package: 'T01', role: 'implementation-or-gate', dependencies: [] };
export const cell = { id: 'local-audit', requirementIds: ['audit.exact'], environmentId: 'node-local', reporter: 'node-tap13',
  command: ['node', '--test', TEST], testNames: ['audit exact input'], timeoutMs: 10000, maxOutputBytes: 100000, logPath: 'evidence/audit.tap' };
export const packageValue = { id: 'T01', parentNode: 'G00', owner: 'author', allowed_files: ['src/example.ts', TEST, MANIFEST],
  surfaceIds: [], requirementIds: [], dependencies: [], interfaceIds: [], referenceIds: [], emittedFiles: [], activation: 'inert', status: 'planned' };
export const audit = { schemaVersion: 1, id: 'audit-T01', assignmentIds: ['T01.I'], allowed_files: packageValue.allowed_files,
  emittedFiles: [], dependencies: [], requirementIds: ['audit.exact'], cells: [cell], artifacts: ['evidence/audit.json'] };
export const tap = 'TAP version 13\n# Subtest: audit exact input\nok 1 - audit exact input\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1\n';
export function registries() {
  return { packages: [], requirements: [], registeredTests: new Set([TEST]), testIds: new Map([[TEST, new Set(cell.testNames)]]),
    packageContext: { nodes: new Set(['G00']), surfaces: new Set(), requirements: new Set(), sourcePaths: new Set(packageValue.allowed_files),
      acceptedInterfaces: new Set(), acceptedReferences: new Set(), acceptedPackages: new Set(), requiredRequirements: new Set(), referenceRequirements: new Map() },
    requirementContext: { nodes: new Set(['G00']), surfaces: new Set(), files: new Map(), testIds: new Map(), platforms: new Set(['node-local']), suites: new Map() } };
}
export function fixture() {
  const base = '1'.repeat(40), subject = '2'.repeat(40), tree = '3'.repeat(40), evidence = '4'.repeat(40);
  const inputs = new Map([['src/example.ts', digest('old\n')], [TEST, digest(source)]]);
  const manifest = { schemaVersion: 1, id: assignment.id, role: assignment.role, kind: 'audit',
    dag: { path: 'docs/dag.json', sha256: digest(canonical([assignment])) }, package: clone(packageValue),
    packageSha256: digest(canonical(structuralPackage(packageValue))), auditContract: { path: 'docs/audit.json', sha256: digest(canonical(audit)) },
    author: 'author', reviewer: 'reviewer', base, inputs: [...inputs].map(([path, sha256]) => ({ path, sha256 })), oversized: [], cells: [clone(cell)], artifacts: [...audit.artifacts] };
  const manifestHash = digest(canonical(manifest));
  const files = new Map([...inputs, ['src/example.ts', digest('new\n')], [MANIFEST, manifestHash]]);
  const diff = [{ status: 'A', oldPath: null, path: MANIFEST }, { status: 'M', oldPath: null, path: 'src/example.ts' }];
  const receipt = { schemaVersion: 1, id: assignment.id, manifestSha256: manifestHash, subject: { sha: subject, tree }, executionBase: base, evidenceCommit: evidence,
    diff, files: [...files].map(([path, sha256]) => ({ path, sha256 })), dependencies: [],
    cells: [{ id: cell.id, environment: clone(environment), command: [...cell.command],
      result: { exitCode: 0, timedOut: false, durationMs: 1, outputBytes: Buffer.byteLength(tap), tests: 1, failures: 0, skips: 0, cancelled: 0, todo: 0 },
      log: { path: 'evidence/audit.tap', sha256: digest(tap) } }], artifacts: [{ path: audit.artifacts[0], sha256: digest('{}\n') }],
    review: { author: 'author', reviewer: 'reviewer', subjectSha: subject, subjectTree: tree, manifestSha256: manifestHash, decision: 'approved' }, status: 'passed' };
  const manifestContext = { ...registries(), assignments: new Map([[assignment.id, clone(assignment)]]),
    authorizations: new Map([[assignment.id, { author: 'author', reviewer: 'reviewer' }]]), environments: new Map([[environment.id, environment]]),
    audits: new Map([[manifest.auditContract.path, { sha256: manifest.auditContract.sha256, value: clone(audit) }]]), dag: clone(manifest.dag),
    baseFiles: new Map([[base, inputs]]), baseLines: new Map([[base, new Map([['src/example.ts', 1], [TEST, physicalLines(Buffer.from(source))]])]]), baseCeilings: new Map([[base, new Map()]]) };
  const fact = { subjectTree: tree, executionBase: base, planningValid: true, ancestry: true, immutableManifest: true, revisionsKnown: true, diff: clone(diff),
    subjectFiles: new Map(files), currentFiles: new Map([...files, [receipt.cells[0].log.path, digest(tap)], [audit.artifacts[0], digest('{}\n')]]),
    subjectLines: new Map([...files.keys()].map(path => [path, 4])), subjectCeilings: new Map(),
    evidenceFiles: new Map([[receipt.cells[0].log.path, digest(tap)], [audit.artifacts[0], digest('{}\n')]]), logs: new Map([[receipt.cells[0].log.path, tap]]) };
  const receiptContext = { manifests: new Map([[assignment.id, manifest]]), manifestHashes: new Map([[assignment.id, manifestHash]]),
    assignments: manifestContext.assignments, environments: manifestContext.environments, facts: new Map([[assignment.id, fact]]), clean: true };
  return { manifest, receipt, manifestContext, receiptContext, fact };
}
export async function repository({ oversized = false, numericBaseline = false, futureTest = false, lifecycle = false, successor = false, platformConditional = false, cellPlatform = process.platform } = {}) {
  const testName = platformConditional ? (process.platform === 'win32' ? 'windows audit' : 'portable audit') : cell.testNames[0];
  const testSource = platformConditional ? "import test from 'node:test';\nif(process.platform === 'win32'){test('windows audit',()=>1);}else{test('portable audit',()=>1);}\n" : source;
  const testEnvironment = { ...environment, platform: cellPlatform };
  const root = await mkdtemp(join(tmpdir(), 'migration-task-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST_')));
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = async (path, value) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };
  const commit = () => { git('add', '--all'); git('-c', 'user.name=Evidence Test', '-c', 'user.email=evidence@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-q');
  const baselinePath = '.source-size-baseline.json', extractionPath = 'src/extracted.mts';
  const scopedPackage = clone(packageValue), scopedAudit = clone(audit);
  scopedAudit.cells[0].testNames = [testName];
  const reviewPath = 'config/migration/tasks/T01.V.json';
  const nextAudit = { ...clone(audit), id: 'audit-T02', assignmentIds: ['T02.I'],
    allowed_files: ['src/example.ts', TEST, 'config/migration/tasks/T02.I.json'],
    cells: [{ ...clone(cell), logPath: 'evidence/next.tap' }], artifacts: ['evidence/next.json'] };
  if (successor) { scopedPackage.allowed_files.push(reviewPath); scopedAudit.allowed_files = scopedPackage.allowed_files; scopedAudit.assignmentIds.push('T01.V'); }
  const baseline = ceiling => ({ version: 1, maximumLines: 500, files: { 'src/example.ts': numericBaseline ? ceiling
    : { ceiling, owner: 'author', reason: 'Extract bounded helper', removalPhase: 'T01' } } });
  if (oversized) { scopedPackage.allowed_files.push(baselinePath, extractionPath); scopedAudit.allowed_files = scopedPackage.allowed_files; }
  await write('src/example.ts', oversized ? 'old\n'.repeat(601) : 'old\n'); if (!futureTest) await write(TEST, testSource);
  if (oversized) await write(baselinePath, baseline(601));
  await write('docs/dag.json', successor ? [assignment, { id: 'T01.V', package: 'T01', role: 'independent-review', dependencies: ['T01.I'] },
    { id: 'T02.I', package: 'T02', role: 'implementation-or-gate', dependencies: ['T01.V'] }] : [assignment]);
  if (successor) await write('docs/audit-next.json', nextAudit); await write('docs/audit.json', scopedAudit);
  const base = commit(), f = fixture();
  const fileHash = path => digest(execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, env }));
  f.manifest.cells[0].testNames = [testName];
  f.receipt.cells[0].environment = testEnvironment;
  if (!futureTest) f.manifest.inputs.find(item => item.path === TEST).sha256 = fileHash(TEST);
  if (futureTest) f.manifest.inputs = f.manifest.inputs.filter(input => input.path !== TEST);
  f.manifest.package = scopedPackage; f.manifest.packageSha256 = digest(canonical(structuralPackage(scopedPackage)));
  f.manifest.inputs[0].sha256 = fileHash('src/example.ts');
  if (oversized) {
    f.manifest.inputs.push({ path: baselinePath, sha256: fileHash(baselinePath) });
    f.manifest.oversized = [{ path: 'src/example.ts', baselineLines: 601, ceiling: 601, extractionTargets: [extractionPath] }];
  }
  f.manifest.base = base; f.manifest.dag.sha256 = fileHash('docs/dag.json'); f.manifest.auditContract.sha256 = fileHash('docs/audit.json');
  await write(MANIFEST, f.manifest);
  if (successor) await write(reviewPath, { ...clone(f.manifest), id: 'T01.V', role: 'independent-review' });
  const planning = commit();
  const manifestHash = fileHash(MANIFEST);
  const catalog = { schemaVersion: 1, dag: { ...f.manifest.dag, revision: base },
    assignments: [{ id: assignment.id, author: 'author', reviewer: 'reviewer', manifest: { path: MANIFEST, sha256: manifestHash, revision: planning } }],
    environments: [testEnvironment], audits: [{ ...f.manifest.auditContract, revision: base }] };
  if (successor) catalog.assignments.push({ id: 'T01.V', author: 'author', reviewer: 'reviewer', manifest: { path: reviewPath, sha256: fileHash(reviewPath), revision: planning } });
  const registry = registries();
  registry.testIds.set(TEST, new Set([testName]));
  if (futureTest) {
    registry.requirementContext.surfaces.add('planned-surface');
    registry.requirementContext.files.set('docs/audit.json', fileHash('docs/audit.json'));
    registry.requirementContext.suites.set('planned-tests', new Set([TEST]));
    registry.requirements = [{ id: 'planned.valid', family: 'G00', surfaceIds: ['planned-surface'], category: 'valid',
      applicability: { status: 'required' }, platformCells: ['node-local'], expectedArtifacts: ['evidence/audit.json'],
      oracleFiles: [{ path: 'docs/audit.json', sha256: fileHash('docs/audit.json') }],
      testBindings: [{ suiteId: 'planned-tests', file: TEST, testId: testName, command: cell.command,
        timeoutMs: 10000, maxOutputBytes: 100000 }] }];
  }
  const observations = [];
  const observe = async (stage, snapshot = false) => {
    if (!lifecycle) return;
    const { loadTaskEvidence } = await import('../tools/migration/load-task-evidence.mjs');
    if (!snapshot) { observations.push({ stage, result: await loadTaskEvidence(root, registry) }); return; }
    git('add', '--all'); const tree = git('write-tree');
    const revision = git('-c', 'user.name=Evidence Test', '-c', 'user.email=evidence@example.invalid', 'commit-tree', tree, '-p', 'HEAD', '-m', 'staged snapshot');
    const path = await mkdtemp(join(tmpdir(), 'migration-task-snapshot-'));
    git('worktree', 'add', '--quiet', '--detach', path, revision);
    try { observations.push({ stage, result: await loadTaskEvidence(path, registry) }); }
    finally { git('worktree', 'remove', '--force', path); }
  };
  const writeLock = async () => {
    const io = await createEvidenceIO(root);
    const paths = ['config/migration/task-contracts.json'];
    try { await io.readRepositoryFile('config/migration/task-receipts.json'); paths.push('config/migration/task-receipts.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const files = [];
    for (const path of paths) files.push({ path: path.split('/').at(-1), sha256: digest(await io.readRepositoryFile(path)) });
    await write('config/migration/review-lock.json', { schemaVersion: 1, files });
  };
  await write('config/migration/task-contracts.json', catalog); await writeLock(); await observe('activation-snapshot', true); const executionBase = commit();
  await observe('activation');
  if (futureTest) await write(TEST, testSource);
  await write('src/example.ts', oversized ? 'new\n'.repeat(550) : 'new\n');
  if (oversized) { await write(baselinePath, baseline(550)); await write(extractionPath, 'export const extracted = true;\n'); }
  await observe('subject-snapshot', true);
  const subject = commit(), tree = git('rev-parse', 'HEAD^{tree}'); await observe('subject');
  const started = performance.now();
  const log = execFileSync(process.execPath, ['--test', TEST], { cwd: root, env, timeout: 10000, encoding: 'utf8' });
  const elapsed = performance.now() - started;
  await write('evidence/audit.tap', log); await write('evidence/audit.json', '{}\n'); await observe('evidence-snapshot', true); const evidence = commit(); await observe('evidence');
  const receipt = f.receipt;
  receipt.executionBase = executionBase; receipt.manifestSha256 = manifestHash; receipt.subject = { sha: subject, tree }; receipt.evidenceCommit = evidence;
  receipt.review = { ...receipt.review, subjectSha: subject, subjectTree: tree, manifestSha256: manifestHash };
  receipt.diff = (await createEvidenceIO(root)).diff(executionBase, subject);
  receipt.files = scopedPackage.allowed_files.map(path => ({ path, sha256: fileHash(path) }));
  receipt.cells[0].log.sha256 = digest(log); receipt.cells[0].result.outputBytes = Buffer.byteLength(log); receipt.cells[0].result.durationMs = elapsed;
  const receipts = [receipt];
  if (successor) {
    const reviewed = clone(receipt); reviewed.id = 'T01.V'; reviewed.manifestSha256 = fileHash(reviewPath); reviewed.review.manifestSha256 = reviewed.manifestSha256;
    reviewed.dependencies = [{ id: 'T01.I', sha256: digest(canonical(receipt)) }]; receipts.push(reviewed);
  }
  await write('config/migration/task-receipts.json', { schemaVersion: 1, receipts }); await writeLock(); await observe('receipt-snapshot', true); commit(); await observe('receipt');
  return { root, git, write, writeLock, observe, commit, observations, receipts, nextAudit, executionBase, receipt, catalog, manifest: f.manifest, subject, evidence, planning, context: registry,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
export async function activateSuccessor(repo) {
  const base = repo.git('rev-parse', 'HEAD'), manifest = clone(repo.manifest);
  const io = await createEvidenceIO(repo.root), path = 'config/migration/tasks/T02.I.json';
  manifest.id = 'T02.I'; manifest.role = 'implementation-or-gate'; manifest.base = base;
  manifest.author = 'next-author'; manifest.reviewer = 'next-reviewer';
  manifest.package = { ...clone(packageValue), id: 'T02', owner: manifest.author, allowed_files: repo.nextAudit.allowed_files };
  manifest.packageSha256 = digest(canonical(structuralPackage(manifest.package)));
  manifest.auditContract = { path: 'docs/audit-next.json', sha256: digest(io.fileAt(base, 'docs/audit-next.json')) };
  manifest.cells = clone(repo.nextAudit.cells); manifest.artifacts = [...repo.nextAudit.artifacts];
  manifest.inputs = ['src/example.ts', TEST].map(path => ({ path, sha256: digest(io.fileAt(base, path)) }));
  await repo.write(path, manifest); const planning = repo.commit();
  repo.catalog.assignments.push({ id: manifest.id, author: manifest.author, reviewer: manifest.reviewer,
    manifest: { path, sha256: digest(io.fileAt(planning, path)), revision: planning } });
  repo.catalog.audits.push({ ...manifest.auditContract, revision: repo.manifest.base });
  await repo.write('config/migration/task-contracts.json', repo.catalog); await repo.writeLock();
  await repo.observe('successor-activation-snapshot', true); const executionBase = repo.commit(); await repo.observe('successor-activation');
  return { manifest, executionBase };
}
export async function completeSuccessor(repo, next) {
  const io = await createEvidenceIO(repo.root), subject = next.subject ?? io.head(), receipt = clone(repo.receipt);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && !key.startsWith('NODE_TEST_')));
  const started = performance.now();
  const log = execFileSync(process.execPath, ['--test', TEST], { cwd: repo.root, env, timeout: 10000, encoding: 'utf8' });
  const elapsed = performance.now() - started;
  await repo.write(next.manifest.cells[0].logPath, log); await repo.write(next.manifest.artifacts[0], '{}\n');
  await repo.observe('successor-evidence-snapshot', true); const evidence = repo.commit();
  const manifestPath = repo.catalog.assignments.find(item => item.id === next.manifest.id).manifest.path;
  receipt.id = next.manifest.id; receipt.executionBase = next.executionBase; receipt.subject = { sha: subject, tree: io.tree(subject) };
  receipt.evidenceCommit = evidence; receipt.manifestSha256 = digest(io.fileAt(subject, manifestPath));
  receipt.diff = io.diff(next.executionBase, subject);
  receipt.files = next.manifest.package.allowed_files.map(path => ({ path, sha256: digest(io.fileAt(subject, path)) }));
  receipt.dependencies = [{ id: 'T01.V', sha256: digest(canonical(repo.receipts.find(item => item.id === 'T01.V'))) }];
  receipt.artifacts = [{ path: next.manifest.artifacts[0], sha256: digest('{}\n') }];
  receipt.cells[0].log = { path: next.manifest.cells[0].logPath, sha256: digest(log) };
  receipt.cells[0].result.durationMs = elapsed; receipt.cells[0].result.outputBytes = Buffer.byteLength(log);
  receipt.review = { author: next.manifest.author, reviewer: next.manifest.reviewer, subjectSha: subject,
    subjectTree: receipt.subject.tree, manifestSha256: receipt.manifestSha256, decision: 'approved' };
  repo.receipts.push(receipt);
  await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: repo.receipts }); await repo.writeLock();
  await repo.observe('successor-receipt-snapshot', true); repo.commit(); await repo.observe('successor-receipt');
  return receipt;
}

export function capturedSuccessorFixture({ repeated = false } = {}) {
  const f = fixture(), context = f.receiptContext, path = 'src/example.ts';
  const h0 = f.fact.subjectFiles.get(path), h1 = digest('captured first edit\n'), h2 = digest('captured second edit\n');
  const originalId = 'T02.I', replacementId = 'T02.retry1.I';
  context.capturedSuccessors = new Map(); context.pendingSuccessors = new Map();
  const addManifest = (id, input, dependencies) => {
    const manifest = clone(f.manifest);
    manifest.id = id; manifest.package.id = 'T02'; manifest.inputs.find(item => item.path === path).sha256 = input;
    context.manifests.set(id, manifest); context.manifestHashes.set(id, digest(canonical(manifest)));
    context.assignments.set(id, { id, package: 'T02', role: manifest.role, dependencies });
    return manifest;
  };
  addManifest(originalId, h0, [f.receipt.id]);
  addManifest(replacementId, h1, [f.receipt.id]);
  const firstSubject = '5'.repeat(40), secondSubject = '6'.repeat(40);
  function bridge(id, nextId, previous, captured, subject, predecessors) {
    const manifest = context.manifests.get(id);
    context.capturedSuccessors.set(id, { replacementId: nextId, subjectSha: subject,
      manifestSha256: context.manifestHashes.get(id), inputs: new Map(manifest.inputs.map(x => [x.path, x.sha256])),
      capturedFiles: new Map([[path, captured]]),
      allowedFiles: new Set(manifest.package.allowed_files), predecessorSubjects: new Set(predecessors),
      dependencies: new Set([f.receipt.id]), valid: true });
  }
  bridge(originalId, replacementId, h0, h1, firstSubject, [f.receipt.subject.sha]);
  let endpoint = replacementId, finalHash = h1;
  if (repeated) {
    endpoint = 'T02.retry2.I'; finalHash = h2;
    addManifest(endpoint, h2, [f.receipt.id]);
    bridge(replacementId, endpoint, h1, h2, secondSubject, [f.receipt.subject.sha, firstSubject]);
  }
  context.pendingSuccessors.set(endpoint, { changedPaths: new Set(), predecessorSubjects: new Set([f.receipt.subject.sha, firstSubject, secondSubject]) });
  f.fact.currentFiles.set(path, finalHash);
  context.facts.set(endpoint, { currentFiles: new Map(f.fact.currentFiles) });
  return { ...f, path, h0, h1, h2, originalId, replacementId, endpoint, firstSubject, secondSubject };
}

export function completeCapturedEndpoint(f) {
  const context = f.receiptContext, manifest = context.manifests.get(f.endpoint), receipt = clone(f.receipt);
  const logPath = 'evidence/replacement.tap', log = tap.replace('# duration_ms 1', '# duration_ms 2');
  manifest.cells[0].logPath = logPath;
  const manifestHash = digest(canonical(manifest)); context.manifestHashes.set(f.endpoint, manifestHash);
  receipt.id = f.endpoint; receipt.manifestSha256 = manifestHash;
  receipt.subject = { sha: '7'.repeat(40), tree: '8'.repeat(40) };
  receipt.files.find(x => x.path === f.path).sha256 = f.fact.currentFiles.get(f.path);
  receipt.dependencies = [{ id: f.receipt.id, sha256: digest(canonical(f.receipt)) }];
  receipt.cells[0].log = { path: logPath, sha256: digest(log) };
  receipt.cells[0].result.durationMs = 2; receipt.cells[0].result.outputBytes = Buffer.byteLength(log);
  receipt.review = { ...receipt.review, subjectSha: receipt.subject.sha, subjectTree: receipt.subject.tree, manifestSha256: manifestHash };
  const fact = clone(f.fact); fact.subjectTree = receipt.subject.tree;
  fact.subjectFiles.set(f.path, f.fact.currentFiles.get(f.path));
  fact.currentFiles.set(logPath, digest(log)); fact.evidenceFiles.set(logPath, digest(log)); fact.logs.set(logPath, log);
  fact.predecessorSubjects = new Set([f.receipt.subject.sha, f.firstSubject, f.secondSubject]);
  context.facts.set(f.endpoint, fact); context.pendingSuccessors.delete(f.endpoint);
  return receipt;
}
