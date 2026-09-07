import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskManifests } from '../tools/migration/task-manifests.mjs';
import { fixture, clone } from './migration_task_support.mjs';

test('task manifests bind an independently scoped audit without product acceptance', () => {
  const f = fixture(), result = validateTaskManifests([f.manifest], f.manifestContext);
  assert.deepEqual(result.errors, []); assert.deepEqual([...result.manifests.keys()], ['T01.I']);
});
test('task manifests reject malformed fields and changes to approved scope or execution identities', () => {
  const mutations = [m => { m.extra = true; }, m => { m.inputs = null; }, m => { m.cells = [null]; },
    m => { m.package.allowed_files.push('../outside'); }, m => { m.package.emittedFiles.push('runtime/out.mjs'); },
    m => { m.packageSha256 = '0'.repeat(64); }, m => { m.dag.sha256 = '0'.repeat(64); }, m => { m.role = 'reference'; },
    m => { m.reviewer = m.author; }, m => { m.base = '0'.repeat(40); }, m => { m.inputs.pop(); },
    m => { m.cells[0].testNames = ['different name']; }, m => { m.cells[0].command = ['sh', '-c', 'true']; },
    m => { m.cells[0].environmentId = 'unknown'; }, m => { m.cells[0].reporter = 'nested'; },
    m => { m.cells[0].requirementIds = []; }, m => { m.artifacts = null; }, m => { m.oversized = null; },
    m => { m.auditContract.sha256 = '0'.repeat(64); }, m => { m.kind = 'package'; }];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.manifest);
    const result = validateTaskManifests([f.manifest], f.manifestContext);
    assert.ok(result.errors.length, String(mutate)); assert.equal(result.manifests.size, 0);
  }
});
test('task manifest invalid batches unlock no otherwise valid entry', () => {
  const f = fixture();
  for (const manifests of [null, [f.manifest, null], [f.manifest, clone(f.manifest)]]) {
    const result = validateTaskManifests(manifests, f.manifestContext);
    assert.ok(result.errors.length); assert.equal(result.manifests.size, 0);
  }
});
test('task manifests bound eight modules and require an owned extraction and baseline for oversized sources', async () => {
  const { digest, canonical } = await import('../tools/migration/evidence-io.mjs');
  const { structuralPackage } = await import('../tools/migration/task-manifests.mjs');
  const f = fixture();
  const freezeAudit = () => {
    const item = f.manifestContext.audits.get(f.manifest.auditContract.path);
    item.value.allowed_files = [...f.manifest.package.allowed_files];
    item.sha256 = digest(canonical(item.value)); f.manifest.auditContract.sha256 = item.sha256;
    f.manifest.packageSha256 = digest(canonical(structuralPackage(f.manifest.package)));
  };
  f.manifest.package.allowed_files.push(...Array.from({ length: 8 }, (_, index) => `tools/leaf-${index}.mjs`)); freezeAudit();
  assert.ok(validateTaskManifests([f.manifest], f.manifestContext).errors.some(error => error.includes('eight production')));
  f.manifest.package.allowed_files.splice(4); freezeAudit();
  f.manifestContext.baseLines.get(f.manifest.base).set('src/example.ts', 600);
  f.manifestContext.baseCeilings.get(f.manifest.base).set('src/example.ts', 700);
  f.manifest.oversized = [{ path: 'src/example.ts', baselineLines: 600, ceiling: 700, extractionTargets: ['tools/leaf-0.mjs'] }];
  assert.ok(validateTaskManifests([f.manifest], f.manifestContext).errors.some(error => error.includes('extraction')));
  f.manifest.package.allowed_files.push('.source-size-baseline.json'); freezeAudit();
  assert.deepEqual(validateTaskManifests([f.manifest], f.manifestContext).errors, []);
  f.manifest.oversized[0].extractionTargets = [];
  assert.ok(validateTaskManifests([f.manifest], f.manifestContext).errors.some(error => error.includes('extraction')));
});
test('product task manifests require every registered scenario binding and platform', async () => {
  const { digest, canonical } = await import('../tools/migration/evidence-io.mjs');
  const { structuralPackage } = await import('../tools/migration/task-manifests.mjs');
  const f = fixture(), ctx = f.manifestContext, m = f.manifest, file = m.cells[0].command[2];
  m.kind = 'package'; m.auditContract = null; m.package.surfaceIds = ['surface']; m.package.requirementIds = ['product.valid']; m.package.referenceIds = ['reference'];
  m.cells[0].requirementIds = ['product.valid']; m.packageSha256 = digest(canonical(structuralPackage(m.package)));
  ctx.packages = [clone(m.package)]; ctx.packageContext.surfaces.add('surface'); ctx.packageContext.requirements.add('product.valid');
  ctx.packageContext.requiredRequirements.add('product.valid'); ctx.packageContext.acceptedReferences.add('reference');
  ctx.packageContext.referenceRequirements.set('reference', new Set(['product.valid']));
  ctx.requirementContext.surfaces.add('surface'); ctx.requirementContext.files.set('src/example.ts', m.inputs[0].sha256);
  ctx.requirementContext.testIds.set(file, new Set(['audit exact input', 'second scenario'])); ctx.testIds.set(file, new Set(['audit exact input', 'second scenario']));
  ctx.requirementContext.suites.set('unit', new Set([file]));
  const binding = { suiteId: 'unit', file, testId: 'audit exact input', command: m.cells[0].command, timeoutMs: 10000, maxOutputBytes: 100000 };
  ctx.requirements = [{ id: 'product.valid', family: 'G00', surfaceIds: ['surface'], category: 'valid', applicability: { status: 'required' },
    platformCells: ['node-local'], oracleFiles: [{ path: 'src/example.ts', sha256: m.inputs[0].sha256 }], testBindings: [binding], expectedArtifacts: m.artifacts }];
  assert.deepEqual(validateTaskManifests([m], ctx).errors, []);
  ctx.requirements[0].testBindings.push({ ...binding, testId: 'second scenario' });
  assert.ok(validateTaskManifests([m], ctx).errors.some(error => error.includes('test binding omitted')));
  m.cells[0].testNames.push('second scenario'); assert.deepEqual(validateTaskManifests([m], ctx).errors, []);
  ctx.requirementContext.platforms.add('second-platform'); ctx.requirements[0].platformCells.push('second-platform');
  assert.ok(validateTaskManifests([m], ctx).errors.some(error => error.includes('environment cell omitted')));
});
test('source size scope mirrors repository extensions and exclusions independently of production ownership', async () => {
  const { sourceSizePath, modulePath } = await import('../tools/migration/task-manifests.mjs');
  for (const path of ['qa/check.tsx', 'qa/check.jsx', 'qa/check.mts', 'qa/check.cts', 'tools/contracts/reference.py', 'tests_js/fixture.mjs', 'other/helper.sh']) assert.equal(sourceSizePath(path), true, path);
  for (const path of ['docs/plan.md', 'config/plan.json', 'tests_js/data.json', 'src/.py', 'src/build/file.ts', 'qa/node_modules/a.ts', '.next/test.js']) assert.equal(sourceSizePath(path), false, path);
  for (const path of ['qa/check.tsx', 'qa/check.jsx', 'qa/check.mts', 'qa/check.cts']) assert.equal(modulePath(path), true, path);
  for (const path of ['tools/contracts/reference.py', 'tests_js/fixture.mjs']) assert.equal(modulePath(path), false, path);
  const f = fixture(), path = 'config/large-plan.json';
  f.manifest.package.allowed_files.push(path); f.manifestContext.baseLines.get(f.manifest.base).set(path, 1000);
  const { digest, canonical } = await import('../tools/migration/evidence-io.mjs');
  const { structuralPackage } = await import('../tools/migration/task-manifests.mjs');
  f.manifest.packageSha256 = digest(canonical(structuralPackage(f.manifest.package)));
  const audit = f.manifestContext.audits.get(f.manifest.auditContract.path); audit.value.allowed_files.push(path);
  audit.sha256 = digest(canonical(audit.value)); f.manifest.auditContract.sha256 = audit.sha256;
  assert.deepEqual(validateTaskManifests([f.manifest], f.manifestContext).errors, []);
  f.manifest.package.allowed_files.push(...Array.from({ length: 8 }, (_, index) => `qa/worker-${index}.tsx`));
  assert.ok(validateTaskManifests([f.manifest], f.manifestContext).errors.some(error => error.includes('eight production')));
});
test('accepted product predecessors do not silently release ownership to a ready successor', async () => {
  const { validatePackages } = await import('../tools/migration/packages.mjs');
  const f = fixture(), context = f.manifestContext.packageContext;
  context.surfaces.add('surface'); context.requirements.add('scenario'); context.requiredRequirements.add('scenario');
  context.acceptedReferences.add('reference'); context.referenceRequirements.set('reference', new Set(['scenario']));
  context.acceptedPackages.add('T01');
  const previous = { ...clone(f.manifest.package), surfaceIds: ['surface'], requirementIds: ['scenario'], referenceIds: ['reference'], status: 'implemented' };
  const next = { ...clone(previous), id: 'T02', owner: 'next-author', dependencies: ['T01'], status: 'ready' };
  const errors = validatePackages([previous, next], context);
  assert.ok(errors.some(error => error.startsWith('Overlapping ownership')));
  assert.equal(errors.some(error => error.startsWith('Unaccepted dependency')), false);
  assert.equal(context.releasedPackages, undefined);
});
