import test from 'node:test';
import assert from 'node:assert/strict';
import { assignmentsFrom, implementationFor } from '../tools/migration/task-lineage.mjs';
import { lineageFixture, rejects } from './migration_task_lineage_support.mjs';

test('P07 lineage preserves accepted DAG edges and their exact receipt bindings', () => {
  const f = lineageFixture(), result = f.run(); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.activeAssignments.get('A.V'), f.before[1]);
  assert.deepEqual([...f.context.receiptIds], ['A.I', 'A.V']);
  f.context.receiptIds.add('B.I'); rejects(f, /receipted/);
  const altered = lineageFixture(); altered.context.dagsByHash.get(altered.transition.nextDag.sha256).get('A.V').dependencies = [];
  rejects(altered, /Historical assignment/);
});
test('P07 lineage binds immutable versions and rejects cycles or fake ancestry', () => {
  for (const key of ['immutable', 'beforeActivation', 'attemptsValid', 'versionsValid', 'historyValid']) {
    const f = lineageFixture(); f.context.facts.get('replacement')[key] = false; rejects(f, /Unverified/);
  }
  const f = lineageFixture(); f.after[0].dependencies = ['C.V']; assert.throws(() => assignmentsFrom(f.after), /cyclic/);
  for (const field of ['authorizedAtFreeze', 'receiptedAtFreeze', 'authorizedAtActivation', 'receiptedAtActivation']) {
    const early = lineageFixture(); early.context.facts.get('replacement')[field].add('C.I'); rejects(early, /refinement/);
  }
  const wrong = lineageFixture(); wrong.transition.previousDag = { ...wrong.transition.previousDag, revision: 'b'.repeat(40) };
  rejects(wrong, /transition/);
});
test('P07 lineage maps implementation and review roles without laundering acceptance', () => {
  const f = lineageFixture(), result = f.run(); assert.deepEqual(result.errors, []);
  assert.equal(implementationFor(result.activeAssignments, 'B.retry1.V'), 'B.retry1.I');
  assert.deepEqual([...result.retiredTasks], ['B.I', 'B.V']);
  assert.equal(result.activeAssignments.has('B.I'), false); assert.equal('acceptedTasks' in result, false);
  f.context.manifests.get('B.retry1.V').role = 'implementation-or-gate'; rejects(f, /role/);
  const handoff = lineageFixture(); handoff.context.handoffTaskIds.add('B.V'); rejects(handoff, /bound/);
});
test('P07 lineage rejects competing transitions and ambiguous active versions', () => {
  const f = lineageFixture(); f.value.transitions.push(structuredClone(f.transition)); rejects(f, /transition/);
  const duplicate = lineageFixture(); duplicate.transition.retirements[1].replacementId = 'B.retry1.I'; rejects(duplicate, /competing/);
  const unbound = lineageFixture(); unbound.context.authorizations.delete('B.retry1.I'); rejects(unbound, /identity/);
});
test('P07 lineage preserves required coverage across approved refinements', () => {
  for (const [key, value] of [['testNames', ['renamed']], ['requirementIds', []], ['environmentId', 'different'], ['timeoutMs', 1001], ['maxOutputBytes', 10001], ['logPath', 'evidence/old.tap']]) {
    const f = lineageFixture(); f.context.manifests.get('B.retry1.I').cells[0][key] = value; rejects(f, /Witness/);
  }
  const f = lineageFixture(); f.context.dagsByHash.get(f.transition.nextDag.sha256).get('B.retry1.I').dependencies = []; rejects(f, /prerequisite/);
  const expanded = lineageFixture();
  expanded.context.manifests.get('B.retry1.I').cells.push({ ...expanded.context.manifests.get('B.retry1.I').cells[0], id: 'additional', testNames: ['additional fixed behavior'], logPath: 'evidence/additional.tap' });
  assert.deepEqual(expanded.run().errors, []);
  for (const field of ['author', 'reviewer']) {
    const actor = lineageFixture(); actor.context.manifests.get('B.retry1.I')[field] = 'different'; rejects(actor, /role/);
  }
  const scope = lineageFixture();
  for (const item of scope.context.manifests.values()) item.kind = 'audit';
  scope.context.manifests.get('B.retry1.I').package.allowed_files = []; rejects(scope, /obligations/);
  const artifact = lineageFixture(); artifact.context.manifests.get('B.retry1.I').artifacts = []; rejects(artifact, /artifacts/);
  const missing = lineageFixture(); missing.transition.witnessMappings.pop(); rejects(missing, /witness/);
  const preparation = lineageFixture();
  preparation.value.preparations.push({ id: 'planning', author: 'root', reviewer: 'hooks_audit', reason: 'Closed planning',
    files: [{ path: 'docs/migration/evidence/planning.md', sha256: 'a'.repeat(64) }] });
  preparation.context.preparationFacts.set('planning', { filesValid: true, historyValid: true });
  assert.deepEqual(preparation.run().errors, []);
  preparation.value.preparations[0].files[0].path = 'src/unowned.ts'; rejects(preparation, /preparation path/);
});
