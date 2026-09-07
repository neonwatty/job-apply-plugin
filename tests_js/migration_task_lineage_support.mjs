import assert from 'node:assert/strict';
import { assignmentsFrom, validateTaskLineage } from '../tools/migration/task-lineage.mjs';
import { digest } from '../tools/migration/evidence-io.mjs';

export function lineageFixture() {
  const bind = name => ({ path: `docs/migration/evidence/${name}.json`, sha256: digest(name), revision: 'a'.repeat(40) });
  const node = (id, dependencies) => ({ id, package: id.split('.')[0], role: id.endsWith('.V') ? 'independent-review' : 'implementation-or-gate', dependencies });
  const before = [node('A.I', []), node('A.V', ['A.I']), node('B.I', ['A.V']), node('B.V', ['B.I']), node('C.I', ['B.V']), node('C.V', ['C.I'])];
  const after = structuredClone(before);
  after[4].dependencies = ['B.retry1.V'];
  after.push(node('B.retry1.I', ['A.V']), node('B.retry1.V', ['B.retry1.I']));
  const rootDag = bind('original'), nextDag = bind('next');
  const manifests = new Map(), authorizations = new Map();
  for (const assignment of [...before.slice(0, 4), ...after.slice(6)]) {
    const id = assignment.id, replacement = id.includes('retry1');
    authorizations.set(id, { manifest: bind(id) });
    manifests.set(id, { id, kind: 'package', author: 'B-author', reviewer: 'B-reviewer', role: assignment.role, package: { id: assignment.package, owner: 'B-author', activation: 'inert', allowed_files: ['src/fixed.ts'], emittedFiles: [], dependencies: [], requirementIds: ['fixed.valid'], interfaceIds: [], referenceIds: [], surfaceIds: [] },
      dag: { path: (replacement ? nextDag : rootDag).path, sha256: (replacement ? nextDag : rootDag).sha256 },
      artifacts: ['evidence/result.json'], cells: [{ id: 'fixed', testNames: ['fixed behavior'], requirementIds: ['fixed.valid'],
        environmentId: 'node-local', timeoutMs: 1000, maxOutputBytes: 10000, logPath: replacement ? 'evidence/new.tap' : 'evidence/old.tap' }] });
  }
  const transition = { schemaVersion: 1, id: 'replacement', previousDag: rootDag, nextDag,
    retirements: ['I', 'V'].map(role => ({ id: `B.${role}`, manifest: bind(`B.${role}`), replacementId: `B.retry1.${role}`, attempt: null })),
    additions: ['I', 'V'].map(role => ({ id: `B.retry1.${role}`, manifest: bind(`B.retry1.${role}`) })),
    refinements: [{ id: 'C.I', beforeDependencies: ['B.V'], afterDependencies: ['B.retry1.V'] }], packageVersions: [],
    witnessMappings: ['I', 'V'].map(role => ({ originalTaskId: `B.${role}`, replacementTaskId: `B.retry1.${role}`, originalCellId: 'fixed', replacementCellId: 'fixed' })),
    author: 'root', reviewer: 'hooks_audit', decision: 'approved', reason: 'Explicit immutable replacement' };
  const context = { rootDag, dagsByHash: new Map([[rootDag.sha256, assignmentsFrom(before)], [nextDag.sha256, assignmentsFrom(after)]]),
    manifests, authorizations, receiptIds: new Set(['A.I', 'A.V']), handoffTaskIds: new Set(), preparationFacts: new Map(),
    facts: new Map([['replacement', { immutable: true, beforeActivation: true, attemptsValid: true, versionsValid: true, historyValid: true, authorizedAtFreeze: new Set(authorizations.keys()), receiptedAtFreeze: new Set(['A.I', 'A.V']), authorizedAtActivation: new Set(authorizations.keys()), receiptedAtActivation: new Set(['A.I', 'A.V']) }]]) };
  const value = { preparations: [], transitions: [transition] };
  return { value, context, transition, before, after, run: () => validateTaskLineage(value, context) };
}
export function rejects(fixture, pattern) {
  const result = fixture.run(); assert.match(result.errors.join('\n'), pattern);
  assert.equal(result.activeAssignments.size, 0); assert.equal(result.replacements.size, 0);
}
export function assertOpen(result) {
  assert.ok(['open', 'invalid'].includes(result.taskEvidence.currentAcceptance));
  assert.deepEqual(result.taskEvidence.acceptedTasks, []);
  assert.deepEqual(result.taskEvidence.acceptedPackages, []);
}
