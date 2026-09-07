import { loadTaskLineage } from './load-task-lineage.mjs';
import { createTaskMetadata, CATALOG, REVIEW_LOCK, HANDOFFS, RECEIPTS, LINEAGE, COORDINATOR } from './task-metadata.mjs';
import { createEvidenceIO, closed, digest, equal, hash, physicalLines, safePath, sha, strings, text } from './evidence-io.mjs';
import { validateTaskManifests, sourceSizePath } from './task-manifests.mjs';
import { validateTaskReceipts } from './task-receipts.mjs';
import { validateTaskHandoffs } from './task-handoffs.mjs';
import { discoverTestIds } from './test-bindings.mjs';

const binding = value => closed(value, ['path', 'sha256', 'revision']) && safePath(value.path) && hash(value.sha256) && sha(value.revision);
const auditFields = ['schemaVersion', 'id', 'assignmentIds', 'allowed_files', 'emittedFiles', 'dependencies', 'requirementIds', 'cells', 'artifacts'];
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
  const empty = () => ({ errors, acceptedTasks: new Set(), acceptedPackages: new Set(), receiptDigests: new Map(), currentAcceptance: errors.length ? 'invalid' : 'open', ownershipHandoffs: [], historicalReadiness: new Map() });
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
    const lineage = await loadTaskLineage(io, { head, catalog, frozen, current });
    const assignments = lineage.allAssignments;
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
      dag: { path: catalog.dag.path, sha256: catalog.dag.sha256 }, ownDagByTask: lineage.ownDagByTask, historicalPackagesByTask: lineage.historicalPackagesByTask, baseFiles, baseLines, baseCeilings, testIds: planningTestIds, phase: 'planning',
      requirementContext: { ...context.requirementContext, testIds: planningTestIds } });
    errors.push(...validated.errors);
    if (errors.length) return empty();
    const receiptBytes = await current(RECEIPTS);
    const collection = receiptBytes === null ? { schemaVersion: 1, receipts: [] } : JSON.parse(receiptBytes);
    if (!closed(collection, ['schemaVersion', 'receipts']) || collection.schemaVersion !== 1 || !Array.isArray(collection.receipts)) throw new Error('Invalid task receipts catalog');
    const handoffBytes = await current(HANDOFFS);
    const handoffShard = handoffBytes === null ? { schemaVersion: 1, handoffs: [] } : JSON.parse(handoffBytes);
    if (!closed(handoffShard, ['schemaVersion', 'handoffs']) || handoffShard.schemaVersion !== 1
      || !Array.isArray(handoffShard.handoffs) || !handoffShard.handoffs.every(binding)
      || new Set(handoffShard.handoffs.map(item => item.path)).size !== handoffShard.handoffs.length) throw new Error('Invalid handoff shard');
    const handoffContracts = [];
    for (const item of handoffShard.handoffs) handoffContracts.push({ binding: item, value: await frozen(item) });
    const planningBindings = new Map([catalog.dag, ...catalog.audits, ...catalog.assignments.map(item => item.manifest), ...handoffShard.handoffs]
      .map(item => [item.path, item.sha256]));
    for (const [path, hash] of lineage.planningBindings) planningBindings.set(path, hash);
    const boundaryCache = new Set();
    const { catalogAt, collectionAt, metadataHistory, reviewLockAt, planningPath, metadataTransition } = createTaskMetadata({
      io, catalog, collection, handoffShard, planningBindings, manifests, baseFiles, authorizations, activated, lineage });
    function activated(manifest, planningCatalog) {
      return planningCatalog.assignments.some(item => equal(item, authorizations.get(manifest.id)))
        && manifest.cells.every(cell => planningCatalog.environments.some(item => equal(item, environments.get(cell.environmentId))))
        && (!manifest.auditContract || planningCatalog.audits.some(item => item.path === manifest.auditContract.path && item.sha256 === manifest.auditContract.sha256));
    }
    function executionBoundary(manifest, revision) {
      const key = `${manifest.id}:${revision}`;
      if (boundaryCache.has(key)) return true;
      const authorization = authorizations.get(manifest.id);
      if (!io.revision(revision) || !io.ancestor(authorization.manifest.revision, revision)
        || !io.ancestor(manifest.base, revision) || !io.ancestor(revision, head)) throw new Error('Invalid execution base ancestry');
      const planningCatalog = catalogAt(revision);
      if (lineage.replacementActivations.has(manifest.id) && !io.ancestor(lineage.replacementActivations.get(manifest.id), revision)) throw new Error('Execution base predates lineage activation');
      if (!activated(manifest, planningCatalog)) throw new Error('Execution base predates assignment activation');
      reviewLockAt(revision);
      for (const change of io.diff(manifest.base, revision)) {
        if (!['A', 'M'].includes(change.status) || !planningPath(change.path, revision)) throw new Error('Source or undeclared edit concealed before execution base');
      }
      for (const input of manifest.inputs) if (digest(io.fileAt(revision, input.path) ?? '') !== input.sha256) {
        if (!COORDINATOR.has(input.path) && !(input.path === 'config/migration/packages.json' && lineage.registryChange(manifest.base, revision))) throw new Error('Execution base changed immutable input');
        metadataTransition(manifest, manifest.base, revision);
      }
      if (digest(io.fileAt(revision, authorization.manifest.path) ?? '') !== authorization.manifest.sha256) throw new Error('Execution base changed frozen manifest');
      for (const contract of handoffContracts.filter(item => item.value.successorPackageId === manifest.package.id)) {
        if (!io.ancestor(contract.binding.revision, revision)
          || !collectionAt(HANDOFFS, revision, 'handoffs', handoffShard.handoffs).some(item => equal(item, contract.binding))) {
          throw new Error('Execution base predates handoff activation');
        }
      }
      if (boundaryCache.size >= 4096) boundaryCache.clear();
      boundaryCache.add(key);
      return true;
    }
    for (const path of [CATALOG, RECEIPTS, HANDOFFS]) metadataHistory(path);
    reviewLockAt(head);
    const pendingSuccessors = new Map();
    const pendingManifests = manifests.filter(manifest => !lineage.retiredTasks.has(manifest.id) && !collection.receipts.some(receipt => receipt?.id === manifest.id));
    const pendingPaths = new Set(pendingManifests.flatMap(manifest => [...manifest.package.allowed_files, ...manifest.artifacts, ...manifest.cells.map(cell => cell.logPath)]));
    const evidencePaths = new Set(collection.receipts.flatMap(receipt => [
      ...(Array.isArray(receipt?.artifacts) ? receipt.artifacts.map(item => item?.path) : []),
      ...(Array.isArray(receipt?.cells) ? receipt.cells.map(item => item?.log?.path) : [])]));
    for (const path of lineage.preservedFiles.keys()) evidencePaths.add(path);
    function completedPeerPath(path) {
      return collection.receipts.some(receipt => {
        const owner = validated.manifests.get(receipt?.id), subject = receipt?.subject?.sha;
        if (!owner?.package.allowed_files.includes(path) || !sha(subject) || !io.revision(subject) || !io.ancestor(subject, head)) return false;
        const prior = io.fileAt(subject, path), actual = io.fileAt(head, path);
        return prior === null ? actual === null : actual !== null && prior.equals(actual);
      });
    }
    const revisions = pendingManifests.length ? [...new Set([...io.changes(CATALOG), ...io.changes(HANDOFFS), ...io.changes(LINEAGE)])]
      .sort((a, b) => io.ancestor(a, b) ? -1 : io.ancestor(b, a) ? 1 : 0) : [];
    for (const manifest of pendingManifests) {
      const activations = revisions.filter(revision => {
        if (io.fileAt(revision, CATALOG) === null) return false;
        try { return (!lineage.replacementActivations.has(manifest.id) || io.ancestor(lineage.replacementActivations.get(manifest.id), revision)) && activated(manifest, catalogAt(revision))
          && handoffContracts.filter(item => item.value.successorPackageId === manifest.package.id)
            .every(item => io.ancestor(item.binding.revision, revision)
              && collectionAt(HANDOFFS, revision, 'handoffs', handoffShard.handoffs).some(value => equal(value, item.binding))); } catch { return false; }
      });
      const executionBase = activations.find(revision => !activations.some(other => other !== revision && io.ancestor(other, revision)));
      executionBoundary(manifest, executionBase);
      const changes = io.diff(executionBase, head);
      for (const change of changes) {
        const paths = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
        if (!['A', 'M', 'D', 'R'].includes(change.status) || paths.some(path => !pendingPaths.has(path)
          && !evidencePaths.has(path) && !completedPeerPath(path) && !planningPath(path, head))) throw new Error(`Undeclared pending task drift: ${change.status} ${change.path}`);
      }
      pendingSuccessors.set(manifest.id, { executionBase, changedPaths: new Set(changes.flatMap(change => [change.path, change.oldPath].filter(Boolean))),
        predecessorSubjects: new Set(collection.receipts.map(receipt => receipt?.subject?.sha).filter(previous => sha(previous) && io.ancestor(previous, manifest.base))) });
    }
    const facts = new Map();
    for (const receipt of collection.receipts) {
      const manifest = validated.manifests.get(receipt?.id), authorization = authorizations.get(receipt?.id);
      if (!manifest || !sha(receipt?.subject?.sha) || !sha(receipt.evidenceCommit)
        || !io.revision(receipt.subject.sha) || !io.revision(receipt.evidenceCommit)) continue;
      if (lineage.retiredTasks.has(receipt.id)) throw new Error('Retired task cannot publish a receipt');
      const subject = receipt.subject.sha;
      if (lineage.replacementActivations.has(receipt.id) && subject === receipt.executionBase) throw new Error('Replacement needs fresh post-activation subject');
      if (lineage.replacementActivations.has(receipt.id) && receipt.cells?.some(cell => lineage.preservedLogHashes.has(cell?.log?.sha256))) throw new Error('Replacement reuses preserved output log');
      const planningValid = executionBoundary(manifest, receipt.executionBase);
      for (const cell of manifest.cells) {
        const source = io.fileAt(subject, cell.command[2]);
        const names = source === null ? new Set() : discoverTestIds(cell.command[2], source.toString('utf8'), { platform: environments.get(cell.environmentId)?.platform });
        if (cell.testNames.some(name => !names.has(name))) throw new Error('Accepted subject lacks declared literal test identities');
      }
      const fact = { coordinatorChanges: new Set(), metadataInputs: new Set(), executionBase: receipt.executionBase, planningValid, subjectTree: io.tree(subject), revisionsKnown: true,
        ancestry: io.ancestor(receipt.executionBase, subject) && io.ancestor(subject, receipt.evidenceCommit)
          && io.ancestor(receipt.evidenceCommit, head),
        immutableManifest: digest(io.fileAt(subject, authorization.manifest.path) ?? '') === authorization.manifest.sha256,
        predecessorSubjects: new Set(collection.receipts.map(item => item?.subject?.sha)
          .filter(previous => sha(previous) && io.ancestor(previous, manifest.base))),
        diff: io.diff(receipt.executionBase, subject), subjectFiles: new Map(), currentFiles: new Map(), subjectLines: new Map(),
        subjectCeilings: ceilings(io.fileAt(subject, '.source-size-baseline.json')), evidenceFiles: new Map(), logs: new Map() };
      if (io.diff(receipt.executionBase, subject).some(change => COORDINATOR.has(change.path))) {
        metadataTransition(manifest, receipt.executionBase, subject);
        for (const change of io.diff(receipt.executionBase, subject)) if (COORDINATOR.has(change.path)) fact.coordinatorChanges.add(change.path);
      }
      for (const path of new Set([...manifest.package.allowed_files, ...manifest.inputs.map(item => item.path)])) {
        const immutable = io.fileAt(subject, path), actual = await current(path);
        fact.subjectFiles.set(path, immutable === null ? null : digest(immutable));
        fact.subjectLines.set(path, immutable === null ? 0 : physicalLines(immutable));
        fact.currentFiles.set(path, actual === null ? null : digest(actual));
        const input = manifest.inputs.find(item => item.path === path);
        if (input && COORDINATOR.has(path) && (fact.subjectFiles.get(path) !== input.sha256 || fact.currentFiles.get(path) !== input.sha256)) {
          metadataTransition(manifest, manifest.base, subject);
          metadataTransition(manifest, subject, head, true);
          fact.metadataInputs.add(path);
        }
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
    const pendingWork = [...pendingSuccessors].some(([id, pending]) => [...pending.changedPaths].some(path =>
      validated.manifests.get(id).package.allowed_files.includes(path) && !planningBindings.has(path) && !COORDINATOR.has(path)));
    const capturedSuccessors = new Map();
    const historicalSubjects = [...collection.receipts.map(receipt => receipt.subject.sha),
      ...[...lineage.capturedSuccessors.values()].map(item => item.subjectSha)];
    for (const [id, bridge] of lineage.capturedSuccessors) {
      const original = validated.manifests.get(id), dag = lineage.ownDagByTask.get(id);
      const dependencies = new Set();
      function visit(task) {
        for (const dependency of dag.get(task)?.dependencies ?? []) if (!dependencies.has(dependency)) {
          dependencies.add(dependency); visit(dependency);
        }
      }
      visit(id);
      capturedSuccessors.set(id, { ...bridge, dependencies,
        predecessorSubjects: new Set(historicalSubjects.filter(subject => io.ancestor(subject, original.base))) });
    }
    const verified = validateTaskReceipts(collection.receipts, { manifests: validated.manifests, manifestHashes, assignments, ownDagByTask: lineage.ownDagByTask, environments, facts, pendingSuccessors, capturedSuccessors, pendingWork, clean: true });
    if (verified.errors.length) { errors.push(...verified.errors); return empty(); }
    function priorReceiptClosure(id, revision, seen = new Set()) {
      if (seen.has(id)) return true;
      seen.add(id);
      const prior = collection.receipts.find(item => item.id === id);
      const historical = collectionAt(RECEIPTS, revision, 'receipts', collection.receipts);
      if (!prior || !historical.some(item => equal(item, prior)) || !io.ancestor(prior.evidenceCommit, revision)) return false;
      return prior.dependencies.every(dependency => verified.receiptDigests.get(dependency.id) === dependency.sha256
        && priorReceiptClosure(dependency.id, revision, seen));
    }
    const handoffFacts = new Map();
    for (const { binding: entry, value } of handoffContracts) {
      const successor = validated.manifests.get(value?.successorTaskId), predecessor = collection.receipts.find(item => item?.id === value?.predecessorReviewTaskId);
      if (!successor || !predecessor) continue;
      const receipt = collection.receipts.find(item => item?.id === value.successorTaskId);
      const executionBase = receipt?.executionBase ?? pendingSuccessors.get(value.successorTaskId)?.executionBase;
      const paths = Array.isArray(value.paths) ? value.paths.map(item => item?.path).filter(safePath) : [];
      handoffFacts.set(value.id, { immutable: true, predecessorReadyAtFreeze: priorReceiptClosure(value.predecessorReviewTaskId, entry.revision), beforeExecution: io.ancestor(entry.revision, executionBase),
        predecessorAncestry: io.ancestor(predecessor.subject.sha, successor.base),
        predecessorFiles: new Map(paths.map(path => [path, digest(io.fileAt(predecessor.subject.sha, path) ?? '')])),
        successorBaseFiles: new Map(paths.map(path => [path, digest(io.fileAt(successor.base, path) ?? '')])) });
    }
    const handoffs = validateTaskHandoffs(handoffContracts.map(item => item.value), {
      packages: new Map(context.packages.map(item => [item.id, item])), manifests: validated.manifests, manifestHashes, assignments,
      receipts: new Map(collection.receipts.map(item => [item.id, item])), receiptDigests: verified.receiptDigests,
      historicalAcceptedTasks: verified.historicalAcceptedTasks, facts: handoffFacts });
    if (handoffs.errors.length) { errors.push(...handoffs.errors); return empty(); }
    function transferred(from, to, path, seen = new Set()) {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return handoffContracts.some(item => item.value.predecessorPackageId === from
        && item.value.paths.some(value => value.path === path) && transferred(item.value.successorPackageId, to, path, new Set(seen)));
    }
    for (const successor of manifests.filter(item => item.role !== 'independent-review' && !lineage.retiredTasks.has(item.id))) {
      const changed = pendingSuccessors.get(successor.id)?.changedPaths
        ?? new Set(facts.get(successor.id)?.diff.flatMap(item => [item.path, item.oldPath].filter(Boolean)) ?? []);
      for (const predecessor of manifests.filter(item => item.kind === 'package' && item.role === 'independent-review'
        && item.package.id !== successor.package.id && verified.historicalAcceptedTasks.has(item.id))) {
        const prior = collection.receipts.find(item => item.id === predecessor.id);
        if (!io.ancestor(prior.subject.sha, successor.base)) continue;
        if (predecessor.package.allowed_files.some(path => successor.package.allowed_files.includes(path) && changed.has(path)
          && (successor.kind !== 'package' || !transferred(predecessor.package.id, successor.package.id, path)))) {
          errors.push(`${successor.id}: product edits require a frozen predecessor handoff`);
        }
      }
    }
    if (errors.length) return empty();
    if (io.head() !== head) throw new Error('HEAD changed during task evidence validation');
    return { ...verified, ...handoffs, planningTestIds, retiredTasks: lineage.retiredTasks, activeAssignments: lineage.activeAssignments };
  } catch (error) { errors.push(`Task evidence: ${error.message}`); return empty(); }
}
