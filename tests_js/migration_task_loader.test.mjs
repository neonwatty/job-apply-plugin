import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTaskEvidence } from '../tools/migration/load-task-evidence.mjs';
import { repository, MANIFEST } from './migration_task_support.mjs';

test('task loader binds actual tested Git subject separately from later evidence commits', async () => {
  const repo = await repository();
  try {
    assert.notEqual(repo.subject, repo.evidence); assert.notEqual(repo.evidence, repo.git('rev-parse', 'HEAD'));
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(result.errors, []); assert.deepEqual([...result.acceptedTasks], ['T01.I']); assert.equal(result.acceptedPackages.size, 0);
  } finally { await repo.cleanup(); }
});
test('task loader rejects dirty and untracked evidence without executing receipt commands', async () => {
  const repo = await repository();
  try {
    await repo.write('untracked.txt', 'extra');
    assert.match((await loadTaskEvidence(repo.root, repo.context)).errors.join('\n'), /clean tracked/);
    await rm(join(repo.root, 'untracked.txt')); await repo.write('src/example.ts', 'drift');
    assert.match((await loadTaskEvidence(repo.root, repo.context)).errors.join('\n'), /clean tracked/);
    repo.git('checkout', '--', 'src/example.ts');
    repo.receipt.cells[0].command = ['sh', '-c', 'touch SHOULD_NOT_EXIST'];
    await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] }); repo.commit();
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.ok(result.errors.length); assert.equal(result.acceptedTasks.size, 0); assert.equal(repo.git('status', '--porcelain'), '');
  } finally { await repo.cleanup(); }
});
test('task loader rejects tracked symlinks, altered frozen manifests and out of scope subject edits', async () => {
  for (const kind of ['symlink', 'manifest', 'scope', 'sha', 'log']) {
    const repo = await repository();
    try {
      if (kind === 'symlink') {
        await rm(join(repo.root, 'evidence/audit.tap')); await symlink('../audit.json', join(repo.root, 'evidence/audit.tap'));
      } else if (kind === 'manifest') { repo.manifest.reviewer = 'different'; await repo.write(MANIFEST, repo.manifest); }
      else if (kind === 'log') await repo.write('evidence/audit.tap', 'fabricated');
      else if (kind === 'sha') {
        repo.receipt.subject.sha = '0'.repeat(40); await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] });
      } else {
        await repo.write('outside.txt', 'outside'); const subject = repo.commit();
        repo.receipt.subject = { sha: subject, tree: repo.git('rev-parse', 'HEAD^{tree}') };
        repo.receipt.evidenceCommit = subject;
        Object.assign(repo.receipt.review, { subjectSha: subject, subjectTree: repo.receipt.subject.tree });
        await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] });
      }
      repo.commit(); const result = await loadTaskEvidence(repo.root, repo.context);
      assert.ok(result.errors.length, kind); assert.equal(result.acceptedTasks.size, 0);
    } finally { await repo.cleanup(); }
  }
});
test('task loader preserves absent catalog behavior', async () => {
  const repo = await repository();
  try {
    await rm(join(repo.root, 'config/migration/task-contracts.json'));
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(result.errors, []); assert.equal(result.acceptedTasks.size, 0);
  } finally { await repo.cleanup(); }
});
test('task Git reads ignore replacement objects for declared immutable revisions', async () => {
  const repo = await repository();
  try {
    const { createEvidenceIO } = await import('../tools/migration/evidence-io.mjs');
    const io = await createEvidenceIO(repo.root), before = io.fileAt(repo.subject, 'src/example.ts');
    const tree = io.tree(repo.subject), diff = io.diff(repo.manifest.base, repo.subject);
    const copy = io.fileAt(repo.subject, 'src/example.ts'); copy.fill(0);
    assert.equal(io.fileAt(repo.subject, 'src/example.ts').toString(), before.toString());
    assert.equal(io.clean(), true);
    await repo.write('untracked-cache-proof.txt', 'fresh filesystem state');
    assert.equal(io.clean(), false);
    await rm(join(repo.root, 'untracked-cache-proof.txt'));
    assert.equal(io.clean(), true);
    await repo.write('src/example.ts', 'replacement bytes\n'); const replacement = repo.commit();
    repo.git('replace', repo.subject, replacement);
    assert.equal(io.revision(repo.subject), true); assert.equal(io.fileAt(repo.subject, 'src/example.ts').toString(), before.toString());
    assert.equal(io.tree(repo.subject), tree); assert.deepEqual(io.diff(repo.manifest.base, repo.subject), diff);
    assert.equal(io.ancestor(replacement, repo.subject), false);
    assert.equal(io.ancestor(replacement, repo.subject), false);
    assert.throws(() => io.fileAt(repo.subject, 'src'), /regular tracked/);
    const fresh = await createEvidenceIO(repo.root);
    assert.equal(fresh.fileAt(repo.subject, 'src/example.ts').toString(), before.toString());
  } finally { await repo.cleanup(); }
});
test('task loader reads actual object-form source-size baselines and verifies a shrinking extraction', async () => {
  const repo = await repository({ oversized: true });
  try {
    const base = JSON.parse(repo.git('show', `${repo.manifest.base}:.source-size-baseline.json`));
    assert.deepEqual(base.files['src/example.ts'], { ceiling: 601, owner: 'author', reason: 'Extract bounded helper', removalPhase: 'T01' });
    const subject = JSON.parse(repo.git('show', `${repo.subject}:.source-size-baseline.json`));
    assert.equal(subject.files['src/example.ts'].ceiling, 550);
    assert.deepEqual((await loadTaskEvidence(repo.root, repo.context)).errors, []);
  } finally { await repo.cleanup(); }
  const invalid = await repository({ oversized: true, numericBaseline: true });
  try { assert.match((await loadTaskEvidence(invalid.root, invalid.context)).errors.join('\n'), /Invalid immutable source-size baseline/); }
  finally { await invalid.cleanup(); }
});
test('task lifecycle validates staged planning, future tests, subject, evidence and receipt commits', async () => {
  const repo = await repository({ futureTest: true, lifecycle: true });
  try {
    assert.deepEqual(repo.observations.map(item => item.stage), ['activation-snapshot', 'activation', 'subject-snapshot', 'subject', 'evidence-snapshot', 'evidence', 'receipt-snapshot', 'receipt']);
    for (const { stage, result } of repo.observations) {
      assert.deepEqual(result.errors, [], stage);
      assert.equal(result.currentAcceptance, stage.startsWith('receipt') ? 'accepted' : 'open', stage);
      if (!stage.startsWith('receipt')) assert.equal(result.acceptedTasks.size, 0);
      assert.deepEqual([...result.planningTestIds.get('tests_js/audit.test.mjs')], ['audit exact input']);
    }
    assert.notEqual(repo.receipt.executionBase, repo.manifest.base);
    assert.equal(repo.receipt.diff.some(change => change.path === MANIFEST), false);
  } finally { await repo.cleanup(); }
});
test('task lifecycle opens acceptance during a frozen successor and rejects undeclared drift', async () => {
  const { activateSuccessor, completeSuccessor } = await import('./migration_task_support.mjs');
  const repo = await repository({ successor: true, lifecycle: true });
  try {
    const initial = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(initial.errors, []); assert.deepEqual([...initial.acceptedTasks], ['T01.I', 'T01.V']);
    const next = await activateSuccessor(repo);
    await repo.write('src/example.ts', 'approved successor edit\n'); await repo.observe('successor-source-snapshot', true); repo.commit();
    const pending = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(pending.errors, []); assert.equal(pending.currentAcceptance, 'open'); assert.equal(pending.acceptedTasks.size, 0); assert.equal(pending.acceptedPackages.size, 0);
    for (const observation of repo.observations) assert.deepEqual(observation.result.errors, [], observation.stage);
    next.subject = repo.git('rev-parse', 'HEAD');
    repo.catalog.environments.push({ id: 'unused-reviewed-environment', platform: 'future', node: 'future', unicode: 'future' });
    await repo.write('config/migration/task-contracts.json', repo.catalog); await repo.writeLock(); repo.commit();
    const parallelActivation = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(parallelActivation.errors, []); assert.equal(parallelActivation.currentAcceptance, 'open');
    assert.equal(parallelActivation.acceptedTasks.size, 0);
    const pendingSubject = repo.git('rev-parse', 'HEAD');
    await repo.write('undeclared.ts', 'unauthorized source\n'); repo.commit();
    const rejected = await loadTaskEvidence(repo.root, repo.context);
    assert.match(rejected.errors.join('\n'), /Undeclared pending task drift/); assert.equal(rejected.acceptedTasks.size, 0);
    repo.git('reset', '--hard', pendingSubject);
    await completeSuccessor(repo, next);
    const completed = await loadTaskEvidence(repo.root, repo.context);
    assert.deepEqual(completed.errors, []); assert.equal(completed.currentAcceptance, 'accepted');
    assert.deepEqual([...completed.acceptedTasks], ['T01.I', 'T01.V', 'T02.I']);
    assert.equal(completed.acceptedPackages.size, 0);
    for (const observation of repo.observations) assert.deepEqual(observation.result.errors, [], observation.stage);
  } finally { await repo.cleanup(); }
});
test('execution base cannot conceal source edits or use a fabricated review lock', async () => {
  for (const kind of ['source', 'lock']) {
    const repo = await repository();
    try {
      if (kind === 'source') repo.receipt.executionBase = repo.subject;
      else {
        await repo.write('config/migration/review-lock.json', { schemaVersion: 1, files: [] });
        const revision = repo.commit(); repo.receipt.executionBase = revision;
      }
      await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] }); repo.commit();
      const result = await loadTaskEvidence(repo.root, repo.context);
      assert.ok(result.errors.length, kind); assert.equal(result.acceptedTasks.size, 0);
    } finally { await repo.cleanup(); }
  }
});
test('accepted subject must contain its declared literal test identities even when planning deferred discovery', async () => {
  const repo = await repository({ futureTest: true });
  try {
    const { TEST, source } = await import('./migration_task_support.mjs');
    await repo.write(TEST, source.replace('audit exact input', 'different literal identity'));
    const subject = repo.commit(); repo.receipt.subject = { sha: subject, tree: repo.git('rev-parse', 'HEAD^{tree}') };
    repo.receipt.evidenceCommit = subject;
    Object.assign(repo.receipt.review, { subjectSha: subject, subjectTree: repo.receipt.subject.tree });
    await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [repo.receipt] }); repo.commit();
    const result = await loadTaskEvidence(repo.root, repo.context);
    assert.match(result.errors.join('\n'), /Accepted subject lacks declared literal test identities/); assert.equal(result.acceptedTasks.size, 0);
  } finally { await repo.cleanup(); }
});
