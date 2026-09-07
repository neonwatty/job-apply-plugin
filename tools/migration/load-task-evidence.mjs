import { createEvidenceIO, closed, digest, equal, hash, physicalLines, safePath, sha, strings, text } from './evidence-io.mjs';
import { validateTaskManifests, sourceSizePath } from './task-manifests.mjs';
import { validateTaskReceipts } from './task-receipts.mjs';
import { discoverTestIds } from './test-bindings.mjs';

const CATALOG = 'config/migration/task-contracts.json';
const REVIEW_LOCK = 'config/migration/review-lock.json';
const RECEIPTS = 'config/migration/task-receipts.json';
const binding = value => closed(value, ['path', 'sha256', 'revision']) && safePath(value.path) && hash(value.sha256) && sha(value.revision);
const auditFields = ['schemaVersion', 'id', 'assignmentIds', 'allowed_files', 'emittedFiles', 'dependencies', 'requirementIds', 'cells', 'artifacts'];
function assignmentsFrom(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Empty approved task DAG');
  const assignments = new Map();
  for (const item of value) {
    if (!closed(item, ['id', 'package', 'role', 'dependencies']) || !text(item.id) || !text(item.package)
      || !['reference', 'implementation-or-gate', 'independent-review'].includes(item.role)
      || !strings(item.dependencies, true) || assignments.has(item.id)) throw new Error('Invalid approved DAG assignment');
    assignments.set(item.id, item);
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (!assignments.has(id) || visiting.has(id)) throw new Error('Unknown/cyclic approved dependency');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of assignments.get(id).dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  }
  for (const id of assignments.keys()) visit(id);
  return assignments;
}
function ceilings(bytes) {
  if (bytes === null) return new Map();
  const value = JSON.parse(bytes);
  if (!closed(value, ['version', 'maximumLines', 'files']) || value.version !== 1 || value.maximumLines !== 500
    || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)
    || Object.entries(value.files).some(([path, entry]) => !safePath(path) || !sourceSizePath(path)
      || !closed(entry, ['ceiling', 'owner', 'reason', 'removalPhase'])
      || !Number.isSafeInteger(entry.ceiling) || entry.ceiling <= 500
      || ![entry.owner, entry.reason, entry.removalPhase].every(text))) {
    throw new Error('Invalid immutable source-size baseline');
  }
  return new Map(Object.entries(value.files).map(([path, entry]) => [path, entry.ceiling]));
}

// Fixed Git/filesystem reads only; execution claims never become executable argv.
export async function loadTaskEvidence(root, context) {
  const errors = [];
  const empty = () => ({ errors, acceptedTasks: new Set(), acceptedPackages: new Set(), receiptDigests: new Map(), currentAcceptance: errors.length ? 'invalid' : 'open' });
  try {
    const io = await createEvidenceIO(root);
    let bytes;
    try { bytes = await io.readRepositoryFile(CATALOG); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
    const head = io.head();
    if (!io.clean()) throw new Error('Task evidence requires a clean tracked checkout');
    async function current(path) {
      const tracked = io.fileAt(head, path);
      let actual = null;
      try { actual = await io.readRepositoryFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if ((tracked === null) !== (actual === null) || tracked !== null && !tracked.equals(actual)) throw new Error('Untracked/dirty task evidence');
      return actual;
    }
    async function frozen(item) {
      if (!binding(item) || !io.revision(item.revision) || !io.ancestor(item.revision, head)) throw new Error('Invalid frozen contract revision');
      const immutable = io.fileAt(item.revision, item.path), actual = await current(item.path);
      if (immutable === null || actual === null || digest(immutable) !== item.sha256 || digest(actual) !== item.sha256) throw new Error('Frozen contract differs');
      return JSON.parse(immutable);
    }
    if (!(await current(CATALOG))?.equals(bytes)) throw new Error('Untracked task catalog');
    const catalog = JSON.parse(bytes);
    if (!closed(catalog, ['schemaVersion', 'dag', 'assignments', 'environments', 'audits']) || catalog.schemaVersion !== 1
      || !Array.isArray(catalog.assignments) || !Array.isArray(catalog.environments) || !Array.isArray(catalog.audits)) throw new Error('Invalid task catalog');
    const assignments = assignmentsFrom(await frozen(catalog.dag));
    const environments = new Map(), audits = new Map(), authorizations = new Map(), manifestHashes = new Map();
    for (const item of catalog.environments) {
      if (!closed(item, ['id', 'platform', 'node', 'unicode']) || !Object.values(item).every(text) || environments.has(item.id)) throw new Error('Invalid task environment');
      environments.set(item.id, item);
    }
    for (const item of catalog.audits) {
      const value = await frozen(item);
      if (audits.has(item.path) || !closed(value, auditFields) || value.schemaVersion !== 1 || !text(value.id)
        || !strings(value.assignmentIds) || value.assignmentIds.some(id => !assignments.has(id))
        || !strings(value.allowed_files) || !value.allowed_files.every(safePath)
        || !strings(value.emittedFiles, true) || !strings(value.dependencies, true) || !strings(value.requirementIds)
        || !Array.isArray(value.cells) || !strings(value.artifacts, true)) throw new Error('Invalid audit contract');
      audits.set(item.path, { sha256: item.sha256, value });
    }
    const manifests = [], baseFiles = new Map(), baseLines = new Map(), baseCeilings = new Map();
    const testIds = new Map(context.testIds ?? context.requirementContext?.testIds ?? []);
    for (const item of catalog.assignments) {
      if (!closed(item, ['id', 'author', 'reviewer', 'manifest']) || !assignments.has(item.id) || authorizations.has(item.id)
        || !text(item.author) || !text(item.reviewer)) throw new Error('Invalid task authorization');
      const manifest = await frozen(item.manifest);
      if (manifest.id !== item.id || !sha(manifest.base) || !io.revision(manifest.base)
        || !io.ancestor(manifest.base, item.manifest.revision) || manifest.base === item.manifest.revision
        || !manifest.package?.allowed_files?.includes(item.manifest.path)) throw new Error('Manifest must own its frozen planning file after the input base');
      authorizations.set(item.id, item); manifestHashes.set(item.id, item.manifest.sha256); manifests.push(manifest);
      if (!Array.isArray(manifest.package.allowed_files) || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.cells)) throw new Error('Malformed task manifest');
      const paths = [...manifest.package.allowed_files, ...manifest.inputs.map(input => input?.path)];
      const files = baseFiles.get(manifest.base) ?? new Map(), lines = baseLines.get(manifest.base) ?? new Map();
      for (const path of paths) {
        const value = io.fileAt(manifest.base, path);
        files.set(path, value === null ? null : digest(value)); lines.set(path, value === null ? 0 : physicalLines(value));
      }
      baseFiles.set(manifest.base, files); baseLines.set(manifest.base, lines);
      baseCeilings.set(manifest.base, ceilings(io.fileAt(manifest.base, '.source-size-baseline.json')));
    }
    const planningTestIds = new Map(testIds);
    for (const manifest of manifests) for (const cell of manifest.cells) {
      if (Array.isArray(cell?.testNames) && cell.testNames.every(text) && safePath(cell?.command?.[2])) {
        const names = new Set(planningTestIds.get(cell.command[2]) ?? []);
        for (const name of cell.testNames) names.add(name);
        planningTestIds.set(cell.command[2], names);
      }
    }
    const validated = validateTaskManifests(manifests, { ...context, assignments, authorizations, environments, audits,
      dag: { path: catalog.dag.path, sha256: catalog.dag.sha256 }, baseFiles, baseLines, baseCeilings, testIds: planningTestIds, phase: 'planning',
      requirementContext: { ...context.requirementContext, testIds: planningTestIds } });
    errors.push(...validated.errors);
    if (errors.length) return empty();
    const receiptBytes = await current(RECEIPTS);
    const collection = receiptBytes === null ? { schemaVersion: 1, receipts: [] } : JSON.parse(receiptBytes);
    if (!closed(collection, ['schemaVersion', 'receipts']) || collection.schemaVersion !== 1 || !Array.isArray(collection.receipts)) throw new Error('Invalid task receipts catalog');
    const planningBindings = new Map([catalog.dag, ...catalog.audits, ...catalog.assignments.map(item => item.manifest)]
      .map(item => [item.path, item.sha256]));
    function catalogAt(revision) {
      const value = io.fileAt(revision, CATALOG);
      if (value === null) throw new Error('Execution base lacks task authorization catalog');
      const prior = JSON.parse(value);
      if (!closed(prior, ['schemaVersion', 'dag', 'assignments', 'environments', 'audits']) || prior.schemaVersion !== 1
        || !equal(prior.dag, catalog.dag)) throw new Error('Planning catalog identity differs');
      for (const key of ['assignments', 'environments', 'audits']) {
        if (!Array.isArray(prior[key]) || new Set(prior[key].map(item => item?.id ?? item?.path)).size !== prior[key].length
          || prior[key].some(item => !catalog[key].some(approved => equal(approved, item)))) throw new Error('Planning catalog authorization differs');
      }
      return prior;
    }
    function reviewLockAt(revision) {
      const value = io.fileAt(revision, REVIEW_LOCK);
      if (value === null) throw new Error('Missing planning review lock');
      const lock = JSON.parse(value);
      const paths = io.pathsAt(revision).filter(path => /^config\/migration\/[^/]+\.json$/.test(path) && path !== REVIEW_LOCK);
      if (!closed(lock, ['schemaVersion', 'files']) || lock.schemaVersion !== 1 || !Array.isArray(lock.files)
        || !equal(lock.files.map(item => `config/migration/${item?.path}`).sort(), paths.sort())
        || lock.files.some(item => !closed(item, ['path', 'sha256']) || !hash(item.sha256)
          || digest(io.fileAt(revision, `config/migration/${item.path}`) ?? '') !== item.sha256)) throw new Error('Invalid exact planning review lock');
    }
    function planningPath(path, revision) {
      if (path === CATALOG) { catalogAt(revision); return true; }
      if (path === REVIEW_LOCK) { reviewLockAt(revision); return true; }
      if (!planningBindings.has(path)) return false;
      return digest(io.fileAt(revision, path) ?? '') === planningBindings.get(path);
    }
    function activated(manifest, planningCatalog) {
      return planningCatalog.assignments.some(item => equal(item, authorizations.get(manifest.id)))
        && manifest.cells.every(cell => planningCatalog.environments.some(item => equal(item, environments.get(cell.environmentId))))
        && (!manifest.auditContract || planningCatalog.audits.some(item => item.path === manifest.auditContract.path && item.sha256 === manifest.auditContract.sha256));
    }
    function executionBoundary(manifest, revision) {
      const authorization = authorizations.get(manifest.id);
      if (!io.revision(revision) || !io.ancestor(authorization.manifest.revision, revision)
        || !io.ancestor(manifest.base, revision) || !io.ancestor(revision, head)) throw new Error('Invalid execution base ancestry');
      const planningCatalog = catalogAt(revision);
      if (!activated(manifest, planningCatalog)) throw new Error('Execution base predates assignment activation');
      reviewLockAt(revision);
      for (const change of io.diff(manifest.base, revision)) {
        if (!['A', 'M'].includes(change.status) || !planningPath(change.path, revision)) throw new Error('Source or undeclared edit concealed before execution base');
      }
      for (const input of manifest.inputs) if (digest(io.fileAt(revision, input.path) ?? '') !== input.sha256) throw new Error('Execution base changed immutable input');
      if (digest(io.fileAt(revision, authorization.manifest.path) ?? '') !== authorization.manifest.sha256) throw new Error('Execution base changed frozen manifest');
      return true;
    }
    const pendingSuccessors = new Map();
    const pendingManifests = manifests.filter(manifest => !collection.receipts.some(receipt => receipt?.id === manifest.id));
    const pendingPaths = new Set(pendingManifests.flatMap(manifest => [...manifest.package.allowed_files, ...manifest.artifacts, ...manifest.cells.map(cell => cell.logPath)]));
    const evidencePaths = new Set(collection.receipts.flatMap(receipt => [
      ...(Array.isArray(receipt?.artifacts) ? receipt.artifacts.map(item => item?.path) : []),
      ...(Array.isArray(receipt?.cells) ? receipt.cells.map(item => item?.log?.path) : [])]));
    for (const manifest of pendingManifests) {
      const executionBase = io.changes(CATALOG).find(revision => {
        if (io.fileAt(revision, CATALOG) === null) return false;
        try { return activated(manifest, catalogAt(revision)); } catch { return false; }
      });
      executionBoundary(manifest, executionBase);
      const changes = io.diff(executionBase, head);
      for (const change of changes) {
        const paths = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
        if (!['A', 'M', 'D', 'R'].includes(change.status) || paths.some(path => !pendingPaths.has(path)
          && !evidencePaths.has(path) && path !== RECEIPTS && !planningPath(path, head))) throw new Error('Undeclared pending task drift');
      }
      pendingSuccessors.set(manifest.id, { executionBase, changedPaths: new Set(changes.flatMap(change => [change.path, change.oldPath].filter(Boolean))),
        predecessorSubjects: new Set(collection.receipts.map(receipt => receipt?.subject?.sha).filter(previous => sha(previous) && io.ancestor(previous, manifest.base))) });
    }
    const facts = new Map();
    for (const receipt of collection.receipts) {
      const manifest = validated.manifests.get(receipt?.id), authorization = authorizations.get(receipt?.id);
      if (!manifest || !sha(receipt?.subject?.sha) || !sha(receipt.evidenceCommit)
        || !io.revision(receipt.subject.sha) || !io.revision(receipt.evidenceCommit)) continue;
      const subject = receipt.subject.sha;
      const planningValid = executionBoundary(manifest, receipt.executionBase);
      for (const cell of manifest.cells) {
        const source = io.fileAt(subject, cell.command[2]);
        const names = source === null ? new Set() : discoverTestIds(cell.command[2], source.toString('utf8'));
        if (cell.testNames.some(name => !names.has(name))) throw new Error('Accepted subject lacks declared literal test identities');
      }
      const fact = { executionBase: receipt.executionBase, planningValid, subjectTree: io.tree(subject), revisionsKnown: true,
        ancestry: io.ancestor(receipt.executionBase, subject) && io.ancestor(subject, receipt.evidenceCommit)
          && io.ancestor(receipt.evidenceCommit, head),
        immutableManifest: digest(io.fileAt(subject, authorization.manifest.path) ?? '') === authorization.manifest.sha256,
        predecessorSubjects: new Set(collection.receipts.map(item => item?.subject?.sha)
          .filter(previous => sha(previous) && io.ancestor(previous, manifest.base))),
        diff: io.diff(receipt.executionBase, subject), subjectFiles: new Map(), currentFiles: new Map(), subjectLines: new Map(),
        subjectCeilings: ceilings(io.fileAt(subject, '.source-size-baseline.json')), evidenceFiles: new Map(), logs: new Map() };
      for (const path of new Set([...manifest.package.allowed_files, ...manifest.inputs.map(item => item.path)])) {
        const immutable = io.fileAt(subject, path), actual = await current(path);
        fact.subjectFiles.set(path, immutable === null ? null : digest(immutable));
        fact.subjectLines.set(path, immutable === null ? 0 : physicalLines(immutable));
        fact.currentFiles.set(path, actual === null ? null : digest(actual));
      }
      const logs = Array.isArray(receipt.cells) ? receipt.cells.map(cell => cell?.log) : [];
      for (const item of [...(Array.isArray(receipt.artifacts) ? receipt.artifacts : []), ...logs]) {
        if (!safePath(item?.path)) continue;
        const immutable = io.fileAt(receipt.evidenceCommit, item.path), actual = await current(item.path);
        fact.evidenceFiles.set(item.path, immutable === null ? null : digest(immutable));
        fact.currentFiles.set(item.path, actual === null ? null : digest(actual));
        if (immutable !== null && logs.includes(item)) fact.logs.set(item.path, immutable.toString('utf8'));
      }
      facts.set(receipt.id, fact);
    }
    const verified = validateTaskReceipts(collection.receipts, { manifests: validated.manifests, manifestHashes, assignments, environments, facts, pendingSuccessors, clean: true });
    return { ...verified, planningTestIds: verified.errors.length ? new Map() : planningTestIds };
  } catch (error) { errors.push(`Task evidence: ${error.message}`); return empty(); }
}
