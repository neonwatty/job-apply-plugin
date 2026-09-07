import { implementationFor } from './task-lineage.mjs';
import { validatePackages } from './packages.mjs';
import { validateRequirements } from './requirements.mjs';
import { canonical, closed, digest, equal, hash, safePath, sha, strings, text } from './evidence-io.mjs';

export const structuralPackage = ({ status, ...structure }) => structure;
// Mirror scripts/check-source-size.py: every matching tracked source, regardless of root.
const SOURCE_EXTENSIONS = new Set(['py', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'swift', 'sh', 'c', 'h']);
const EXCLUDED_PARTS = new Set(['.git', '.next', '.worktrees', 'build', 'coverage', 'dist', 'node_modules', 'vendor']);
export const sourceSizePath = path => typeof path === 'string' && SOURCE_EXTENSIONS.has(path.split('/').at(-1).split('.').at(-1))
  && path.split('/').at(-1).lastIndexOf('.') > 0 && !path.split('/').some(part => EXCLUDED_PARTS.has(part));
// Production ownership has a narrower purpose than source-size enforcement.
export const modulePath = path => sourceSizePath(path)
  && /^(?:src|runtime|native|scripts|tools|workspace|qa)\//.test(path) && !path.startsWith('tools/contracts/');
const binding = value => closed(value, ['path', 'sha256']) && safePath(value.path) && hash(value.sha256);
const positive = value => Number.isSafeInteger(value) && value > 0;
const fields = ['schemaVersion', 'id', 'role', 'kind', 'dag', 'package', 'packageSha256', 'auditContract',
  'author', 'reviewer', 'base', 'inputs', 'oversized', 'cells', 'artifacts'];
const cellFields = ['id', 'requirementIds', 'environmentId', 'reporter', 'command', 'testNames', 'timeoutMs', 'maxOutputBytes', 'logPath'];

export function validateTaskManifests(manifests, context) {
  const errors = [], accepted = new Map();
  const result = () => ({ errors, manifests: errors.length ? new Map() : accepted });
  if (!Array.isArray(manifests)) { errors.push('Task manifests must be an array'); return result(); }
  for (const key of ['assignments', 'authorizations', 'environments', 'audits', 'baseFiles', 'baseLines', 'baseCeilings', 'testIds']) {
    if (!(context?.[key] instanceof Map)) errors.push(`Missing task manifest registry ${key}`);
  }
  if (!context?.packageContext || !context?.requirementContext || !Array.isArray(context?.packages)
    || !Array.isArray(context?.requirements) || !(context?.registeredTests instanceof Set)) errors.push('Missing existing structural registries');
  if (errors.length) return result();
  errors.push(...validateRequirements(context.requirements, context.requirementContext));
  if (errors.length) return result();
  const seen = new Set();
  for (const manifest of manifests) {
    if (!closed(manifest, fields)) { errors.push('Invalid task manifest fields'); continue; }
    const fail = message => errors.push(`${manifest.id}: ${message}`);
    if (manifest.schemaVersion !== 1 || !text(manifest.id) || seen.has(manifest.id)) fail('invalid/duplicate manifest ID');
    seen.add(manifest.id);
    const ownDag = context.ownDagByTask?.get(manifest.id) ?? context.assignments;
    const assignment = ownDag.get(manifest.id), authorization = context.authorizations.get(manifest.id);
    if (!assignment || manifest.role !== assignment.role || manifest.package?.id !== assignment.package) fail('assignment differs from approved DAG');
    if (manifest.role === 'independent-review') {
      try { implementationFor(ownDag, manifest.id); } catch (error) { fail(error.message); }
    }
    if (!binding(manifest.dag) || !context.ownDagByTask?.has(manifest.id) && !equal(manifest.dag, context.dag)) fail('approved DAG hash differs');
    if (!['package', 'audit'].includes(manifest.kind)) fail('unsupported task form');
    if (!text(manifest.author) || !text(manifest.reviewer) || manifest.author.trim() === manifest.reviewer.trim()
      || authorization?.author !== manifest.author || authorization?.reviewer !== manifest.reviewer) fail('unbound author or independent reviewer');
    if (!sha(manifest.base) || !context.baseFiles.has(manifest.base)) fail('unknown immutable input base');
    const pkg = manifest.package;
    if (!pkg || !strings(pkg.allowed_files) || !pkg.allowed_files.every(safePath) || !Array.isArray(pkg.emittedFiles)) {
      fail('invalid structural package'); continue;
    }
    if (!hash(manifest.packageSha256) || digest(canonical(structuralPackage(pkg))) !== manifest.packageSha256) fail('structural package hash differs');
    const registeredPackages = context.historicalPackagesByTask?.get(manifest.id) ?? context.packages;
    const registry = registeredPackages.find(item => item.id === pkg.id);
    if (manifest.kind === 'package' && (!registry || !equal(structuralPackage(pkg), structuralPackage(registry)))) fail('unregistered structural package');
    const structural = [...registeredPackages.filter(item => item.id !== pkg.id), pkg].map(item => ({ ...item, status: 'planned' }));
    const structuralErrors = validatePackages(structural, context.packageContext);
    errors.push(...structuralErrors.map(error => `${manifest.id}: ${error}`));
    if (structuralErrors.length) continue;
    if (manifest.kind === 'package') {
      for (const id of pkg.interfaceIds ?? []) if (!context.packageContext.acceptedInterfaces.has(id)) fail('unaccepted interface prerequisite');
      for (const id of pkg.referenceIds ?? []) if (!context.packageContext.acceptedReferences.has(id)) fail('unaccepted reference prerequisite');
      for (const id of pkg.requirementIds ?? []) if (context.packageContext.requiredRequirements.has(id)
        && !(pkg.referenceIds ?? []).some(reference => context.packageContext.acceptedReferences.has(reference)
          && context.packageContext.referenceRequirements.get(reference)?.has(id))) fail('required scenario lacks accepted reference');
    }
    if (pkg.owner !== manifest.author || pkg.activation !== 'inert') fail('package ownership/activation differs');
    if (pkg.allowed_files.filter(path => !pkg.emittedFiles.includes(path) && modulePath(path)).length > 8) fail('more than eight production modules');
    if (!Array.isArray(manifest.inputs) || !manifest.inputs.every(binding)
      || new Set(manifest.inputs.map(item => item.path)).size !== manifest.inputs.length) { fail('invalid immutable input bindings'); continue; }
    else {
      const base = context.baseFiles.get(manifest.base);
      for (const input of manifest.inputs) if (base?.get(input.path) !== input.sha256) fail('input differs from immutable base');
      for (const path of pkg.allowed_files) if (base?.get(path) && !manifest.inputs.some(input => input.path === path)) fail('existing owned file missing input binding');
    }
    if (!Array.isArray(manifest.oversized)) { fail('missing source-size contract'); continue; }
    else {
      const expected = pkg.allowed_files.filter(path => sourceSizePath(path) && (context.baseLines.get(manifest.base)?.get(path) ?? 0) > 500);
      if (!equal(manifest.oversized.map(item => item?.path).sort(), expected.sort())) fail('oversized source coverage differs');
      for (const item of manifest.oversized) {
        if (!closed(item, ['path', 'baselineLines', 'ceiling', 'extractionTargets']) || !safePath(item.path)
          || item.baselineLines !== context.baseLines.get(manifest.base)?.get(item.path)
          || !positive(item.ceiling) || item.ceiling < item.baselineLines
          || !pkg.allowed_files.includes('.source-size-baseline.json')
          || item.ceiling > (context.baseCeilings.get(manifest.base)?.get(item.path) ?? 0)
          || !strings(item.extractionTargets) || item.extractionTargets.some(path => path === item.path
            || !pkg.allowed_files.includes(path) || !sourceSizePath(path))) fail('invalid extraction/nonincreasing ceiling');
      }
    }
    if (!strings(manifest.artifacts, true) || !manifest.artifacts.every(safePath)
      || manifest.artifacts.some(path => pkg.allowed_files.includes(path))) { fail('invalid artifact ownership'); continue; }
    if (!Array.isArray(manifest.cells) || !manifest.cells.length) { fail('missing required execution cells'); continue; }
    const cellIds = new Set(), coverage = new Set();
    for (const cell of manifest.cells) {
      if (!closed(cell, cellFields)) { fail('invalid cell fields'); continue; }
      if (!text(cell.id) || cellIds.has(cell.id)) fail('invalid/duplicate cell ID');
      cellIds.add(cell.id);
      if (cell.reporter !== 'node-tap13' || !context.environments.has(cell.environmentId)) fail('unsupported reporter/environment');
      if (!Array.isArray(cell.command) || cell.command.length !== 3 || cell.command[0] !== 'node' || cell.command[1] !== '--test'
        || !context.registeredTests.has(cell.command[2]) || !pkg.allowed_files.includes(cell.command[2])
        && !manifest.inputs.some(input => input.path === cell.command[2])) fail('unregistered or unbound command');
      if (!strings(cell.testNames) || cell.testNames.some(name => /[\r\n#]/.test(name)
        || context.phase !== 'planning' && !context.testIds.get(cell.command?.[2])?.has(name))) fail('undeclared observed test names');
      if (!safePath(cell.logPath) || pkg.allowed_files.includes(cell.logPath) || manifest.artifacts.includes(cell.logPath)
        || manifest.cells.filter(other => other?.logPath === cell.logPath).length !== 1) fail('invalid declared log path');
      if (!positive(cell.timeoutMs) || !positive(cell.maxOutputBytes) || cell.maxOutputBytes > 8 * 1024 * 1024) fail('invalid execution budgets');
      if (!strings(cell.requirementIds)) fail('missing scenario identities');
      else for (const id of cell.requirementIds) {
        coverage.add(id);
        if (manifest.kind !== 'package') continue;
        const requirement = context.requirements.find(item => item.id === id);
        if (!pkg.requirementIds.includes(id) || requirement?.applicability.status !== 'required'
          || !requirement.platformCells.includes(cell.environmentId)
          || !requirement.testBindings.some(item => equal(item.command, cell.command) && cell.testNames.includes(item.testId)
            && cell.timeoutMs <= item.timeoutMs && cell.maxOutputBytes <= item.maxOutputBytes)) fail('cell differs from required scenario contract');
      }
    }
    if (manifest.kind === 'audit') {
      const audit = binding(manifest.auditContract) && context.audits.get(manifest.auditContract.path);
      if (!audit || audit.sha256 !== manifest.auditContract.sha256 || !audit.value.assignmentIds?.includes(manifest.id)
        || pkg.surfaceIds.length || pkg.requirementIds.length || pkg.referenceIds.length || pkg.interfaceIds.length
        || !equal(pkg.allowed_files, audit.value.allowed_files) || !equal(pkg.emittedFiles, audit.value.emittedFiles)
        || !equal(pkg.dependencies, audit.value.dependencies) || !equal(manifest.cells, audit.value.cells)
        || !equal(manifest.artifacts, audit.value.artifacts) || !equal([...coverage].sort(), [...audit.value.requirementIds].sort())) fail('unbound audit or manufactured product coverage');
    } else {
      if (manifest.auditContract !== null) fail('product manifest carries audit override');
      for (const id of pkg.requirementIds) if (context.requirements.find(item => item.id === id)?.applicability.status === 'required'
        && !coverage.has(id)) fail('required scenario missing cells');
      for (const requirement of context.requirements.filter(item => pkg.requirementIds.includes(item.id) && item.applicability.status === 'required')) {
        for (const environment of requirement.platformCells) if (!manifest.cells.some(cell => cell?.environmentId === environment && cell.requirementIds?.includes(requirement.id))) fail('required environment cell omitted');
        for (const binding of requirement.testBindings) for (const environment of requirement.platformCells) {
          if (!manifest.cells.some(cell => cell?.environmentId === environment && cell.requirementIds?.includes(requirement.id)
            && equal(cell.command, binding.command) && cell.testNames?.includes(binding.testId))) fail('required test binding omitted');
        }
        if (requirement.expectedArtifacts.some(path => !manifest.artifacts.includes(path))) fail('required artifact omitted');
      }
    }
    accepted.set(manifest.id, manifest);
  }
  return result();
}
