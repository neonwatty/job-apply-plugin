import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePackages } from '../tools/migration/packages.mjs';

function fixture() {
  return {
    packages: [{ id: 'leaf', parentNode: 'UI0', owner: 'worker',
      allowed_files: ['src/leaf.ts', 'runtime/leaf.js'], surfaceIds: ['surface'],
      requirementIds: ['requirement'], dependencies: [], interfaceIds: ['interface'],
      referenceIds: ['reference'], emittedFiles: ['runtime/leaf.js'], activation: 'inert', status: 'ready' }],
    context: { nodes: new Set(['UI0']), surfaces: new Set(['surface']),
      requirements: new Set(['requirement']), sourcePaths: new Set(['src/leaf.ts', 'runtime/leaf.js']),
      acceptedInterfaces: new Set(['interface']), acceptedReferences: new Set(['reference']),
      requiredRequirements: new Set(['requirement']), referenceRequirements: new Map([['reference', new Set(['requirement'])]]),
      acceptedPackages: new Set() },
  };
}

test('ready package has explicit scope and accepted inputs without claiming acceptance', () => {
  const { packages, context } = fixture();
  assert.deepEqual(validatePackages(packages, context), []);
  packages[0].status = 'accepted';
  assert.match(validatePackages(packages, context).join('\n'), /Unsupported status/);
});
test('a passing reference for another requirement cannot unlock this package', () => {
  const { packages, context } = fixture();
  context.referenceRequirements.set('reference', new Set(['unrelated']));
  assert.match(validatePackages(packages, context).join('\n'), /does not cover required scenario/);
});
test('accepted historical ownership can be explicitly released for a dependent repair', () => {
  const { packages, context } = fixture();
  const original = packages[0];
  original.status = 'implemented';
  packages.push({ ...original, id: 'repair', status: 'ready', dependencies: ['leaf'] });
  context.acceptedPackages.add('leaf');
  assert.match(validatePackages(packages, context).join('\n'), /Overlapping/);
  context.releasedPackages = new Set(['leaf']);
  assert.deepEqual(validatePackages(packages, context), []);
  assert.deepEqual(original.allowed_files, ['src/leaf.ts', 'runtime/leaf.js']);
  context.acceptedPackages.clear();
  assert.match(validatePackages(packages, context).join('\n'), /Cannot release unaccepted/);
});

test('closed fields, ownership, coverage and inert activation fail closed', () => {
  for (const change of [
    p => { p.extra = true; }, p => { delete p.owner; }, p => { p.owner = ''; },
    p => { p.allowed_files = []; }, p => { p.surfaceIds = []; },
    p => { p.requirementIds = []; }, p => { p.referenceIds = []; },
    p => { p.activation = 'live'; }, p => { p.parentNode = 'missing'; },
    p => { p.emittedFiles = ['runtime/unowned.js']; },
  ]) {
    const { packages, context } = fixture();
    change(packages[0]);
    assert.ok(validatePackages(packages, context).length);
  }
});

test('unsafe or duplicate ownership paths cannot alias active ownership', () => {
  for (const file of ['/absolute.ts', '../escape.ts', 'src/../leaf.ts', 'src//leaf.ts',
    'C:/leaf.ts', 'src\\leaf.ts', 'src/*.ts', 'src/./leaf.ts', '.git/index', 'src/\0leaf']) {
    const { packages, context } = fixture();
    packages[0].allowed_files.push(file);
    assert.match(validatePackages(packages, context).join('\n'), /Unsafe/);
  }
  const { packages, context } = fixture();
  packages[0].allowed_files.push('src/leaf.ts');
  assert.match(validatePackages(packages, context).join('\n'), /duplicate/);
});

test('unknown or unaccepted reference/interface evidence cannot unlock ready work', () => {
  for (const field of ['surfaceIds', 'requirementIds', 'interfaceIds', 'referenceIds']) {
    const { packages, context } = fixture();
    packages[0][field] = ['missing'];
    assert.match(validatePackages(packages, context).join('\n'), /Unknown/);
  }
  const { packages, context } = fixture();
  context.knownReferences = new Set(['reference']);
  context.acceptedReferences.clear();
  assert.match(validatePackages(packages, context).join('\n'), /Unaccepted reference/);
  packages[0].status = 'planned';
  assert.deepEqual(validatePackages(packages, context), []);
});

test('implemented dependency alone is not accepted and cannot unlock a child', () => {
  validateScopedReadiness();
  const { packages, context } = fixture();
  packages.push({ ...structuredClone(packages[0]), id: 'parent', status: 'implemented',
    allowed_files: ['src/parent.ts'], emittedFiles: [] });
  context.sourcePaths.add('src/parent.ts');
  packages[0].dependencies = ['parent'];
  assert.match(validatePackages(packages, context).join('\n'), /Unaccepted dependency/);
  context.acceptedPackages.add('parent');
  assert.deepEqual(validatePackages(packages, context), []);
  packages[1].status = 'planned';
  assert.match(validatePackages(packages, context).join('\n'), /Unaccepted dependency/);
});

test('cycles, unknown dependencies and duplicate IDs are rejected', () => {
  for (const dependency of ['leaf', 'missing']) {
    const { packages, context } = fixture();
    packages[0].dependencies = [dependency];
    assert.ok(validatePackages(packages, context).length);
  }
  const { packages, context } = fixture();
  packages.push(structuredClone(packages[0]));
  assert.match(validatePackages(packages, context).join('\n'), /duplicate package ID/);
});

test('active package ownership overlaps fail even when the named owner is identical', () => {
  const { packages, context } = fixture();
  packages.push({ ...structuredClone(packages[0]), id: 'other' });
  assert.match(validatePackages(packages, context).join('\n'), /Overlapping ownership/);
  packages[1].status = 'planned';
  assert.deepEqual(validatePackages(packages, context), []);
});

test('implemented scope must exist and missing context cannot fabricate readiness', () => {
  const { packages, context } = fixture();
  packages[0].status = 'implemented';
  context.sourcePaths.clear();
  assert.match(validatePackages(packages, context).join('\n'), /Missing implemented file/);
  assert.ok(validatePackages(packages, {}).length);
  assert.ok(validatePackages(null, context).length);
});

function validateScopedReadiness() {
  const empty = () => new Set();
  const context = { nodes: new Set(['I']), surfaces: new Set(['surface']), requirements: new Set(['req']),
    sourcePaths: new Set(['src/shared.ts', 'src/reserved.ts']), acceptedInterfaces: empty(), acceptedReferences: new Set(['ref']),
    acceptedPackages: empty(), requiredRequirements: new Set(['req']), referenceRequirements: new Map([['ref', new Set(['req'])]]),
    ownershipHandoffs: [{ predecessorPackageId: 'A', successorPackageId: 'B', paths: ['src/shared.ts'] }],
    historicalReadiness: new Map([['B', new Set(['A'])]]) };
  const a = { id: 'A', parentNode: 'I', owner: 'author-a', allowed_files: ['src/shared.ts', 'src/reserved.ts'],
    surfaceIds: ['surface'], requirementIds: ['req'], dependencies: [], interfaceIds: [], referenceIds: ['ref'],
    emittedFiles: [], activation: 'inert', status: 'implemented' };
  const b = { ...a, id: 'B', owner: 'author-b', allowed_files: ['src/shared.ts'], dependencies: ['A'], status: 'ready' };
  assert.deepEqual(validatePackages([a, b], context), []);
  assert.deepEqual(validatePackages([b, a], context), []);
  const c = { ...b, id: 'C', allowed_files: ['src/reserved.ts'] };
  const errors = validatePackages([a, b, c], context);
  assert.ok(errors.some(error => error.includes('Unaccepted dependency C:A')));
  assert.ok(errors.some(error => error.includes('Overlapping ownership src/reserved.ts')));
  assert.equal(context.acceptedPackages.size, 0);
  const implementedB = { ...b, status: 'implemented' };
  const d = { ...b, id: 'D', dependencies: ['B'] };
  context.ownershipHandoffs.push({ predecessorPackageId: 'B', successorPackageId: 'D', paths: ['src/shared.ts'] });
  context.historicalReadiness.set('D', new Set(['B']));
  for (const ordered of [[a, implementedB, d], [d, a, implementedB], [implementedB, d, a]]) {
    assert.deepEqual(validatePackages(ordered, context), []);
  }
}
