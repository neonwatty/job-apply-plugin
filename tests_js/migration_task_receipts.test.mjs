import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskReceipts } from '../tools/migration/task-receipts.mjs';
import { parseTaskTap } from '../tools/migration/tap-evidence.mjs';
import { canonical, digest } from '../tools/migration/evidence-io.mjs';
import { fixture, clone, tap } from './migration_task_support.mjs';

test('task receipts accept only exact immutable subject evidence and keep parent acceptance open', () => {
  const f = fixture(), result = validateTaskReceipts([f.receipt], f.receiptContext);
  assert.deepEqual(result.errors, []); assert.deepEqual([...result.acceptedTasks], ['T01.I']);
  assert.equal(result.acceptedPackages.size, 0); assert.equal(result.receiptDigests.get('T01.I'), digest(canonical(f.receipt)));
});
test('task receipts reject wrong names with identical passing counts and unsupported TAP', () => {
  for (const log of [tap.replaceAll('audit exact input', 'different input'), tap.replace('ok 1 -', 'not ok 1 -'),
    tap.replace('ok 1 - audit exact input', 'ok 1 - audit exact input # SKIP'),
    tap.replace('1..1', '    # Subtest: concealed child\n    ok 1 - concealed child\n1..1'), tap.replace('# todo 0', '# todo 1'),
    tap.replace('# cancelled 0', '# cancelled 1'), tap.replace('# fail 0', '# fail 1'), tap.replace('1..1', '1..2')]) {
    const f = fixture(), cell = f.receipt.cells[0]; cell.log.sha256 = digest(log); cell.result.outputBytes = Buffer.byteLength(log);
    f.fact.logs.set(cell.log.path, log); f.fact.evidenceFiles.set(cell.log.path, digest(log)); f.fact.currentFiles.set(cell.log.path, digest(log));
    assert.ok(validateTaskReceipts([f.receipt], f.receiptContext).errors.length);
  }
  assert.deepEqual(parseTaskTap(tap).names, ['audit exact input']);
});
test('task receipts reject self review, wrong SHA, stale inputs, budgets, missing artifacts and ownership escapes', () => {
  const mutations = [f => { f.receipt.subject = null; }, f => { f.receipt.subject.tree = '0'.repeat(40); },
    f => { f.fact.ancestry = false; }, f => { f.fact.immutableManifest = false; }, f => { f.receipt.review.reviewer = 'author'; },
    f => { f.receipt.review.subjectSha = '0'.repeat(40); }, f => { f.receipt.manifestSha256 = '0'.repeat(64); },
    f => { f.fact.currentFiles.set('src/example.ts', '0'.repeat(64)); }, f => { f.fact.subjectFiles.delete('src/example.ts'); },
    f => { f.receipt.cells[0].result.timedOut = true; }, f => { f.receipt.cells[0].result.durationMs = 10001; },
    f => { f.receipt.cells[0].result.outputBytes = 100001; }, f => { f.receipt.cells[0].environment.node = 'different'; },
    f => { f.receipt.cells[0].command = ['sh', '-c', 'true']; }, f => { f.receipt.artifacts = []; },
    f => { f.receipt.diff = null; }, f => { f.receipt.diff[0].path = 'outside'; f.fact.diff = clone(f.receipt.diff); },
    f => { f.receipt.diff[0] = { status: 'R', oldPath: 'outside', path: 'src/example.ts' }; f.fact.diff = clone(f.receipt.diff); },
    f => { f.receipt.files[0].sha256 = null; f.fact.subjectFiles.set(f.receipt.files[0].path, null); f.fact.currentFiles.set(f.receipt.files[0].path, null); },
    f => { f.receiptContext.clean = false; }, f => { f.fact.subjectLines.set('src/example.ts', 501); }];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f); const result = validateTaskReceipts([f.receipt], f.receiptContext);
    assert.ok(result.errors.length, String(mutate)); assert.equal(result.acceptedTasks.size, 0); assert.equal(result.acceptedPackages.size, 0);
  }
});
test('task receipt dependencies are fixed by the approved DAG and invalidate the entire batch', () => {
  const f = fixture(); f.receiptContext.assignments.get('T01.I').dependencies = ['T00.V'];
  assert.ok(validateTaskReceipts([f.receipt], f.receiptContext).errors.some(error => error.includes('dependencies')));
  f.receipt.dependencies = [{ id: 'T00.V', sha256: '0'.repeat(64) }];
  assert.ok(validateTaskReceipts([f.receipt], f.receiptContext).errors.some(error => error.includes('dependency receipt')));
  const clean = fixture(), result = validateTaskReceipts([clean.receipt, null], clean.receiptContext);
  assert.ok(result.errors.length); assert.equal(result.acceptedTasks.size, 0);
});
test('task receipts preserve historical evidence through an approved review and dependent edit chain', () => {
  const f = fixture(), review = clone(f.receipt), successor = clone(f.receipt), context = f.receiptContext;
  review.id = 'T01.V'; review.dependencies = [{ id: 'T01.I', sha256: digest(canonical(f.receipt)) }];
  const reviewManifest = clone(f.manifest); reviewManifest.id = review.id; reviewManifest.role = 'independent-review';
  context.manifests.set(review.id, reviewManifest); context.manifestHashes.set(review.id, review.manifestSha256);
  context.assignments.set(review.id, { id: review.id, package: 'T01', role: 'independent-review', dependencies: ['T01.I'] });
  context.facts.set(review.id, clone(f.fact));
  successor.id = 'T02.I'; successor.subject = { sha: '5'.repeat(40), tree: '6'.repeat(40) };
  successor.review = { ...successor.review, subjectSha: successor.subject.sha, subjectTree: successor.subject.tree };
  successor.dependencies = [{ id: review.id, sha256: digest(canonical(review)) }];
  const nextManifest = clone(f.manifest); nextManifest.id = successor.id; nextManifest.package.id = 'T02';
  const previousHash = f.fact.subjectFiles.get('src/example.ts'), nextHash = digest('approved next edit\n');
  nextManifest.inputs.find(item => item.path === 'src/example.ts').sha256 = previousHash;
  successor.files.find(item => item.path === 'src/example.ts').sha256 = nextHash;
  context.manifests.set(successor.id, nextManifest); context.manifestHashes.set(successor.id, successor.manifestSha256);
  context.assignments.set(successor.id, { id: successor.id, package: 'T02', role: 'implementation-or-gate', dependencies: [review.id] });
  const nextFact = clone(f.fact); nextFact.subjectTree = successor.subject.tree;
  nextFact.predecessorSubjects = new Set([f.receipt.subject.sha]); nextFact.subjectFiles.set('src/example.ts', nextHash);
  context.facts.set(successor.id, nextFact);
  for (const fact of context.facts.values()) fact.currentFiles.set('src/example.ts', nextHash);
  const receipts = [f.receipt, review, successor];
  assert.deepEqual(validateTaskReceipts(receipts, context).errors, []);
  context.pendingWork = true;
  const pendingIndependent = validateTaskReceipts(receipts, context);
  assert.deepEqual(pendingIndependent.errors, []);
  assert.equal(pendingIndependent.currentAcceptance, 'open');
  assert.equal(pendingIndependent.acceptedTasks.size, 0);
  assert.equal(pendingIndependent.acceptedPackages.size, 0);
  context.pendingWork = false;
  f.manifest.kind = 'package'; reviewManifest.kind = 'package';
  assert.ok(validateTaskReceipts(receipts, context).errors.length, 'audit cannot supersede accepted product bytes');
  context.pendingSuccessors = new Map([[successor.id, { changedPaths: new Set(['src/example.ts']), predecessorSubjects: new Set([f.receipt.subject.sha]) }]]);
  assert.ok(validateTaskReceipts([f.receipt, review], context).errors.length, 'pending audit cannot supersede product bytes');
  f.manifest.kind = 'audit'; reviewManifest.kind = 'audit'; context.pendingSuccessors.clear();
  nextFact.predecessorSubjects.clear();
  assert.ok(validateTaskReceipts(receipts, context).errors.some(error => error.includes('stale')));
  nextFact.predecessorSubjects.add(f.receipt.subject.sha); successor.dependencies[0].sha256 = '0'.repeat(64);
  const invalid = validateTaskReceipts(receipts, context); assert.ok(invalid.errors.length); assert.equal(invalid.acceptedTasks.size, 0);
});
test('task receipts enforce rename and deletion ownership and nonincreasing actual source size', () => {
  for (const status of ['D', 'R']) {
    const f = fixture(), path = 'src/example.ts';
    f.receipt.files.find(item => item.path === path).sha256 = null;
    f.fact.subjectFiles.set(path, null); f.fact.currentFiles.set(path, null);
    const change = status === 'D' ? { status, oldPath: null, path } : { status, oldPath: path, path: 'tests_js/audit.test.mjs' };
    f.receipt.diff = [change]; f.fact.diff = clone(f.receipt.diff);
    assert.deepEqual(validateTaskReceipts([f.receipt], f.receiptContext).errors, []);
    change.oldPath = 'outside'; f.fact.diff = clone(f.receipt.diff);
    assert.ok(validateTaskReceipts([f.receipt], f.receiptContext).errors.length);
  }
  const f = fixture(); f.manifest.oversized = [{ path: 'src/example.ts', baselineLines: 600, ceiling: 700, extractionTargets: ['tools/leaf.mjs'] }];
  f.fact.subjectLines.set('src/example.ts', 601); f.fact.subjectCeilings.set('src/example.ts', 700);
  assert.ok(validateTaskReceipts([f.receipt], f.receiptContext).errors.some(error => error.includes('ceiling exceeded')));
});
test('task TAP rejects duplicate headers and results before their announcements', () => {
  assert.equal(parseTaskTap(tap.replace('# Subtest:', 'TAP version 13\n# Subtest:')), null);
  assert.equal(parseTaskTap(tap.replace('# Subtest: audit exact input\nok 1 - audit exact input', 'ok 1 - audit exact input\n# Subtest: audit exact input')), null);
  assert.equal(parseTaskTap(tap.replace('TAP version 13\n', 'TAP version 13\n1..1\n')), null);
});
test('receipt size enforcement includes references and extended source types but excludes planning data', () => {
  for (const [path, rejected] of [['tools/contracts/reference.py', true], ['qa/check.mts', true], ['src/component.tsx', true], ['tests_js/data.json', false], ['docs/large.md', false]]) {
    const f = fixture(), sha256 = digest('fixture');
    f.manifest.package.allowed_files.push(path); f.receipt.files.push({ path, sha256 });
    f.fact.subjectFiles.set(path, sha256); f.fact.currentFiles.set(path, sha256); f.fact.subjectLines.set(path, 501);
    const result = validateTaskReceipts([f.receipt], f.receiptContext);
    assert.equal(result.errors.some(error => error.includes('ceiling exceeded')), rejected, path);
  }
});
test('task receipts bind observed TAP duration to timeout and runner wall time with one millisecond tolerance', () => {
  for (const [duration, wall, rejected] of [[10001, 1, true], [10001, 10000, true], [10, 1, true], [10, 9, false], [10, 8.999, true]]) {
    const f = fixture(), log = tap.replace('# duration_ms 1', `# duration_ms ${duration}`), cell = f.receipt.cells[0];
    cell.result.durationMs = wall; cell.result.outputBytes = Buffer.byteLength(log); cell.log.sha256 = digest(log);
    f.fact.logs.set(cell.log.path, log); f.fact.evidenceFiles.set(cell.log.path, digest(log)); f.fact.currentFiles.set(cell.log.path, digest(log));
    assert.equal(validateTaskReceipts([f.receipt], f.receiptContext).errors.length > 0, rejected, `${duration}/${wall}`);
  }
});

test('task receipts reject duplicate reserved metrics that conceal the terminal duration', () => {
  const f = fixture(), cell = f.receipt.cells[0];
  const log = tap.replace('TAP version 13\n', 'TAP version 13\n# duration_ms 1\n').replace(/# duration_ms 1\n$/, '# duration_ms 10001\n');
  cell.log.sha256 = digest(log); cell.result.outputBytes = Buffer.byteLength(log); cell.result.durationMs = 1;
  f.fact.logs.set(cell.log.path, log); f.fact.evidenceFiles.set(cell.log.path, digest(log)); f.fact.currentFiles.set(cell.log.path, digest(log));
  assert.equal(parseTaskTap(log), null);
  assert.ok(validateTaskReceipts([f.receipt], f.receiptContext).errors.length);
  assert.equal(parseTaskTap(tap.replace('TAP version 13\n', 'TAP version 13\n# pass 1\n')), null);
});
