import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTriageReport, loadTriageReport, SCENARIOS } from '../tools/migration/triage-report.mjs';

const surfaces = [
  { id: 'cli:a', kind: 'cli', node: 'A' },
  { id: 'document:b', kind: 'document', node: 'B' },
];
const planned = {
  id: 'A-valid', surfaceIds: ['cli:a'], family: 'A', category: 'valid',
  applicability: { status: 'required' },
};
const inapplicable = {
  id: 'B-concurrency', surfaceIds: ['document:b'], family: 'B', category: 'concurrency',
  applicability: { status: 'inapplicable', rationale: 'Immutable fixture', reviewer: 'Reviewer', sourcePaths: ['b.py'] },
  oracleFiles: [{ path: 'b.py', sha256: 'abc' }], testBindings: [], expectedArtifacts: [],
};

test('triage report partitions every surface and scenario without treating plans as evidence', () => {
  const report = buildTriageReport(surfaces, [planned, inapplicable]);
  assert.equal(SCENARIOS.length, 10);
  assert.equal(report.totalCells, 20);
  assert.deepEqual(report.counts, {
    'required-planned': 1, 'reviewed-inapplicable': 1, unassessed: 18,
  });
  assert.equal(report.cells.length, 20);
  assert.deepEqual(report.cells[0], {
    surfaceId: 'cli:a', kind: 'cli', node: 'A', category: 'valid',
    status: 'required-planned', requirementId: 'A-valid',
  });
  assert.deepEqual(report.cells[16], {
    surfaceId: 'document:b', kind: 'document', node: 'B', category: 'concurrency',
    status: 'reviewed-inapplicable', requirementId: 'B-concurrency',
  });
  assert.equal(report.byKind.cli.unassessed, 9);
  assert.equal(report.byNode.B['reviewed-inapplicable'], 1);
  assert.equal(report.byCategory.valid['required-planned'], 1);
  assert.equal(report.byCategory.valid.unassessed, 1);
  assert.match(report.note, /not accepted test evidence/);
  assert.match(report.note, /not confirmed behavior differences/);
});

test('triage rejects duplicate, unknown and unsupported mappings', () => {
  assert.throws(() => buildTriageReport(surfaces, [planned, { ...planned, id: 'A-valid-2' }]), /Duplicate cell mapping/);
  assert.throws(() => buildTriageReport(surfaces, [{ ...planned, surfaceIds: ['cli:nope'] }]), /Unknown surface/);
  assert.equal(buildTriageReport(surfaces, [{ ...planned, family: 'B' }]).counts['required-planned'], 1);
  assert.throws(() => buildTriageReport(surfaces, [{ ...planned, applicability: { status: 'passed' } }]), /Unknown applicability/);
  assert.throws(() => buildTriageReport(surfaces, [{ ...inapplicable,
    applicability: { ...inapplicable.applicability, reviewer: '' } }]), /Unreviewed inapplicability/);
  assert.throws(() => buildTriageReport([...surfaces, surfaces[0]], []), /duplicate surface/);
});

test('triage loader combines sorted inventory shards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-triage-'));
  try {
    const directory = join(root, 'config/migration');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'b-surfaces.json'), JSON.stringify({ schemaVersion: 1, surfaces: [surfaces[1]] }));
    await writeFile(join(directory, 'a-surfaces.json'), JSON.stringify({ schemaVersion: 1, surfaces: [surfaces[0]] }));
    await writeFile(join(directory, 'requirements-test.json'), JSON.stringify({ schemaVersion: 1,
      requirements: [planned, inapplicable] }));
    const report = await loadTriageReport(root);
    assert.equal(report.totalCells, 20);
    assert.equal(report.cells[0].surfaceId, 'cli:a');
    assert.deepEqual(report.counts, {
      'required-planned': 1, 'reviewed-inapplicable': 1, unassessed: 18,
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
