import { closed, digest, equal, hash, safePath, sha, strings, text } from './evidence-io.mjs';
import { assignmentsFrom, binding, fileBinding, preparationPath, validateTaskLineage } from './task-lineage.mjs';
import { containsRecords, firstActivations, historicalJson, preservesHistory, recordKeys } from './history-records.mjs';

const LINEAGE = 'config/migration/task-lineage.json';
const CATALOG = 'config/migration/task-contracts.json';
const RECEIPTS = 'config/migration/task-receipts.json';
const PACKAGES = 'config/migration/packages.json';
const COORDINATOR = new Set([CATALOG, RECEIPTS, LINEAGE, 'config/migration/review-lock.json', 'config/migration/task-handoffs.json']);
const structure = ({ status, ...value }) => value;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const sourceState = value => closed(value, ['path', 'sha256']) && safePath(value.path) && (value.sha256 === null || hash(value.sha256));

export async function loadTaskLineage(io, { head, catalog, frozen, current }) {
  if (io.head() !== head) throw new Error('HEAD changed before lineage validation');
  // Histories are queried against HEAD, so keep this cache local and verify HEAD before publishing facts.
  const histories = new Map(); let historyBytes = 0;
  function changes(path) {
    const cached = histories.get(path);
    if (cached) return [...cached];
    const revisions = io.changes(path);
    const size = Buffer.byteLength(path) + revisions.length * 40;
    if (size <= 8 * 1024 * 1024) {
      if (histories.size >= 4096 || historyBytes + size > 8 * 1024 * 1024) {
        histories.clear(); historyBytes = 0;
      }
      histories.set(path, [...revisions]); historyBytes += size;
    }
    return revisions;
  }
  const jsonAt = historicalJson(io);
  const root = await frozen(catalog.dag), dagsByHash = new Map([[catalog.dag.sha256, assignmentsFrom(root)]]);
  const bytes = await current(LINEAGE);
  const shard = bytes === null ? { schemaVersion: 1, preparations: [], transitions: [] } : JSON.parse(bytes);
  function validShard(value) {
    if (!closed(value, ['schemaVersion', 'preparations', 'transitions']) || value.schemaVersion !== 1
      || !Array.isArray(value.preparations) || !Array.isArray(value.transitions) || !value.transitions.every(binding)
      || new Set(value.transitions.map(item => item.path)).size !== value.transitions.length) throw new Error('Invalid lineage shard');
    return value;
  }
  validShard(shard);
  const history = changes(LINEAGE).map(revision => ({ revision, value: validShard(jsonAt(LINEAGE, revision)) }));
  const indexed = new Map();
  for (const key of ['preparations', 'transitions']) {
    const rows = history.map(row => ({ revision: row.revision, records: recordKeys(row.value[key]) }));
    indexed.set(key, rows);
    const latest = recordKeys(shard[key]);
    if (rows.some(row => !containsRecords(latest, row.records))) throw new Error('Lineage history removed or replaced records');
    if (!preservesHistory(rows, io.ancestor, { topological: true })) throw new Error('Lineage branch erased ancestral records');
  }
  const firstRecord = (key, item) => {
    const [identity] = recordKeys([item]);
    const candidates = indexed.get(key).filter(row => row.records.has(identity)).map(row => row.revision);
    const first = firstActivations(candidates, io.ancestor);
    if (first.length !== 1) throw new Error('Ambiguous lineage first activation');
    return first[0];
  };
  const prepared = new Map(), preparationFacts = new Map(), planningBindings = new Map();
  for (const item of [catalog.dag, ...catalog.audits, ...catalog.assignments.map(item => item.manifest)]) planningBindings.set(item.path, item.sha256);
  const authorizations = new Map(), manifests = new Map();
  for (const authorization of catalog.assignments) {
    if (!text(authorization?.id) || !binding(authorization.manifest) || authorizations.has(authorization.id)) throw new Error('Invalid lineage task authorization');
    authorizations.set(authorization.id, authorization); manifests.set(authorization.id, await frozen(authorization.manifest));
  }
  for (const item of shard.preparations) {
    if (!closed(item, ['id', 'author', 'reviewer', 'reason', 'files']) || !Array.isArray(item.files) || !item.files.length) throw new Error('Invalid preparation');
    const revision = firstRecord('preparations', item);
    for (const file of item.files) {
      if (!fileBinding(file) || !preparationPath(file.path) || prepared.has(file.path)) throw new Error('Invalid preparation document');
      const actual = await current(file.path);
      if (actual === null || digest(actual) !== file.sha256 || digest(io.fileAt(revision, file.path) ?? '') !== file.sha256) throw new Error('Prepared document differs');
      if (changes(file.path).some(prior => prior !== revision && io.ancestor(prior, revision)
        && io.fileAt(prior, file.path) !== null)) throw new Error('Preparation overwrites existing document');
      const originalCatalog = jsonAt(CATALOG, revision);
      const protectedPaths = [originalCatalog?.dag?.path, ...(originalCatalog?.assignments ?? []).map(row => row.manifest?.path),
        ...(originalCatalog?.audits ?? []).map(row => row.path)];
      if (protectedPaths.includes(file.path) || [...manifests.values()].some(manifest => manifest.artifacts?.includes(file.path)
        || manifest.cells?.some(cell => cell.logPath === file.path))) throw new Error('Preparation claims bound artifact');
      prepared.set(file.path, { ...file, revision }); planningBindings.set(file.path, file.sha256);
    }
    preparationFacts.set(item.id, { filesValid: true, historyValid: true });
  }
  const contracts = [], facts = new Map(), receiptIds = new Set(), handoffTaskIds = new Set();
  for (const revision of changes(RECEIPTS)) {
    const value = jsonAt(RECEIPTS, revision);
    if (!closed(value, ['schemaVersion', 'receipts']) || value.schemaVersion !== 1 || !Array.isArray(value.receipts)) throw new Error('Invalid historical receipt collection');
    for (const receipt of value.receipts) { if (!text(receipt?.id)) throw new Error('Invalid historical receipt ID'); receiptIds.add(receipt.id); }
  }
  const handoffs = jsonAt('config/migration/task-handoffs.json', head)?.handoffs ?? [];
  for (const entry of handoffs) {
    const contract = await frozen(entry);
    handoffTaskIds.add(contract.predecessorReviewTaskId); handoffTaskIds.add(contract.successorTaskId);
  }
  const registeredVersions = new Map();
  const historicalPackagesByTask = new Map(), replacementActivations = new Map(), preservedLogHashes = new Set();
  const registryActivations = new Map(), preservedFiles = new Map(), transitionByTask = new Map();
  const freezePoints = new Map(), activationByTransition = new Map();
  const ownDagByTask = new Map();
  function originalActivation(id) {
    const authorization = authorizations.get(id);
    const revisions = changes(CATALOG).filter(revision => jsonAt(CATALOG, revision)?.assignments?.some(item => equal(item, authorization)));
    const candidates = firstActivations(revisions, io.ancestor);
    if (candidates.length !== 1) throw new Error('Ambiguous original activation');
    return candidates[0];
  }
  async function preserved(file, revision) {
    if (!fileBinding(file) || !io.revision(revision)) throw new Error('Invalid preserved file binding');
    const value = io.fileAt(revision, file.path), actual = await current(file.path);
    if (value === null || actual === null || digest(value) !== file.sha256 || !actual.equals(value)) throw new Error('Preserved attempt artifact differs');
    preservedFiles.set(file.path, file.sha256); return value;
  }
  async function captureAttempt(retirement, transition, freeze) {
    const attempt = retirement.attempt, manifest = manifests.get(retirement.id);
    if (!closed(attempt, ['subject', 'evidenceCommit', 'capture', 'files', 'artifacts'])
      || !closed(attempt.subject, ['sha', 'tree']) || !sha(attempt.subject.sha) || !sha(attempt.subject.tree)
      || !io.revision(attempt.subject.sha) || io.tree(attempt.subject.sha) !== attempt.subject.tree
      || !sha(attempt.evidenceCommit) || !io.ancestor(attempt.subject.sha, attempt.evidenceCommit)
      || !io.ancestor(attempt.evidenceCommit, freeze) || !Array.isArray(attempt.files) || !attempt.files.every(sourceState)
      || !equal(attempt.files.map(item => item.path).sort(), [...manifest.package.allowed_files].sort())
      || attempt.files.some(item => { const bytes = io.fileAt(attempt.subject.sha, item.path); return (bytes === null ? null : digest(bytes)) !== item.sha256; })
      || !Array.isArray(attempt.artifacts) || !attempt.artifacts.every(fileBinding)) throw new Error('Invalid preserved attempt subject/files');
    const original = originalActivation(retirement.id);
    if (!io.ancestor(original, attempt.subject.sha)) throw new Error('Original subject predates activation');
    const capturePreparation = prepared.get(attempt.capture?.path);
    if (!capturePreparation || capturePreparation.sha256 !== attempt.capture.sha256 || !io.ancestor(attempt.evidenceCommit, capturePreparation.revision)
      || !io.ancestor(capturePreparation.revision, manifests.get(retirement.replacementId).base)) throw new Error('Capture must be prepared before replacement base');
    const capture = JSON.parse(await preserved(attempt.capture, capturePreparation.revision));
    if (!closed(capture, ['schemaVersion', 'id', 'subject', 'executionBase', 'attributions', 'cells']) || capture.schemaVersion !== 1
      || !text(capture.id) || !equal(capture.subject, attempt.subject) || capture.executionBase !== original
      || !Array.isArray(capture.attributions) || !capture.attributions.length || !Array.isArray(capture.cells)) throw new Error('Invalid original capture record');
    const attributed = new Map();
    for (const row of capture.attributions) {
      if (!closed(row, ['taskId', 'manifestSha256', 'cellIds']) || !strings(row.cellIds) || attributed.has(row.taskId)
        || !transition.retirements.some(item => item.id === row.taskId) || authorizations.get(row.taskId)?.manifest.sha256 !== row.manifestSha256) throw new Error('Invalid capture attribution');
      const owner = manifests.get(row.taskId);
      if (!equal([...row.cellIds].sort(), owner.cells.map(cell => cell.id).sort())) throw new Error('Capture attribution omits cells');
      attributed.set(row.taskId, owner);
    }
    if (!attributed.has(retirement.id) || new Set(capture.cells.map(cell => cell.id)).size !== capture.cells.length) throw new Error('Capture task attribution differs');
    const expectedIds = new Set([...attributed.values()].flatMap(owner => owner.cells.map(cell => cell.id)));
    if (!equal([...expectedIds].sort(), capture.cells.map(cell => cell.id).sort())) throw new Error('Capture output cells differ');
    const outputPaths = new Set(), artifactHashes = new Map();
    for (const cell of capture.cells) {
      if (!closed(cell, ['id', 'command', 'environmentId', 'environment', 'result', 'log', 'artifacts', 'diagnostic'])) throw new Error('Invalid capture cell');
      const owners = [...attributed.values()].flatMap(owner => owner.cells.filter(item => item.id === cell.id));
      if (!owners.length || owners.some(owner => !equal(owner.command, cell.command) || owner.environmentId !== cell.environmentId)
        || !closed(cell.environment, ['id', 'platform', 'node', 'unicode'])
        || !catalog.environments.some(environment => equal(environment, cell.environment)) || cell.environment.id !== cell.environmentId) throw new Error('Captured command/environment differs');
      const result = cell.result;
      if (!closed(result, ['exitCode', 'signal', 'timedOut', 'durationMs', 'outputBytes'])
        || !(result.exitCode === null || Number.isInteger(result.exitCode)) || !(result.signal === null || text(result.signal))
        || typeof result.timedOut !== 'boolean' || !nonnegative(result.durationMs) || !Number.isSafeInteger(result.outputBytes) || result.outputBytes < 0
        || !(cell.diagnostic === null || closed(cell.diagnostic, ['code', 'message']) && text(cell.diagnostic.code) && text(cell.diagnostic.message))) throw new Error('Invalid observed capture result');
      if (cell.log === null) {
        if (result.outputBytes !== 0 || owners.some(owner => io.fileAt(attempt.evidenceCommit, owner.logPath) !== null)) throw new Error('Capture omits existing output');
      } else {
        if (owners.some(owner => owner.logPath !== cell.log.path)) throw new Error('Capture log path differs');
        const bytes = await preserved(cell.log, attempt.evidenceCommit);
        if (bytes.length !== result.outputBytes) throw new Error('Captured byte count differs');
        preservedLogHashes.add(cell.log.sha256); outputPaths.add(cell.log.path);
      }
      if (!Array.isArray(cell.artifacts) || !cell.artifacts.every(fileBinding)
        || new Set(cell.artifacts.map(item => item.path)).size !== cell.artifacts.length) throw new Error('Invalid/duplicate capture artifacts');
      for (const artifact of cell.artifacts) {
        if (![...attributed.values()].some(owner => owner.cells.some(item => item.id === cell.id) && owner.artifacts.includes(artifact.path))) throw new Error('Undeclared captured artifact');
        if (artifactHashes.has(artifact.path) && artifactHashes.get(artifact.path) !== artifact.sha256) throw new Error('Conflicting shared capture artifact');
        artifactHashes.set(artifact.path, artifact.sha256);
        await preserved(artifact, attempt.evidenceCommit); outputPaths.add(artifact.path);
      }
    }
    const expectedOutputs = new Set([...attributed.values()].flatMap(owner => [...owner.cells.map(cell => cell.logPath), ...owner.artifacts])
      .filter(path => io.fileAt(attempt.evidenceCommit, path) !== null));
    if (!equal([...outputPaths].sort(), [...expectedOutputs].sort()) || !equal(attempt.artifacts.map(item => item.path).sort(), [...expectedOutputs].sort())) throw new Error('Preserved artifact set differs');
    for (const item of attempt.artifacts) await preserved(item, attempt.evidenceCommit);
    const replacement = manifests.get(retirement.replacementId);
    if (!replacement.inputs.some(input => equal(input, attempt.capture))) throw new Error('Replacement inputs omit preserved capture');
    for (const item of attempt.files) if (item.sha256 !== null && !planningBindings.has(item.path) && !COORDINATOR.has(item.path)) {
      if (!replacement.package.allowed_files.includes(item.path) || !replacement.inputs.some(input => equal(input, item))
        || digest(io.fileAt(replacement.base, item.path) ?? '') !== item.sha256) throw new Error('Adopted attempt source is not owned and input-bound');
    }
    return { subject: attempt.subject.sha, evidenceCommit: attempt.evidenceCommit, covered: new Set([...manifest.package.allowed_files, ...expectedOutputs]) };
  }
  function validateVersions(transition, freeze, activation) {
    const seen = new Set(), before = jsonAt(PACKAGES, freeze);
    const entries = transition.packageVersions;
    for (const entry of entries) {
      if (!closed(entry, ['packageId', 'originalTaskIds', 'replacementTaskIds', 'previous', 'next', 'additions']) || seen.has(entry.packageId)
        || !strings(entry.originalTaskIds) || !strings(entry.replacementTaskIds)
        || !closed(entry.previous, ['packageSha256', 'registry']) || !binding(entry.previous.registry)
        || !closed(entry.next, ['packageSha256', 'registry']) || !fileBinding(entry.next.registry)
        || entry.previous.registry.path !== PACKAGES || entry.next.registry.path !== PACKAGES
        || !closed(entry.additions, ['allowed_files', 'emittedFiles']) || !strings(entry.additions.allowed_files, true)
        || !strings(entry.additions.emittedFiles, true)) throw new Error('Invalid package version binding');
      seen.add(entry.packageId);
      const productRetirements = transition.retirements.filter(item => manifests.get(item.id)?.package.id === entry.packageId && manifests.get(item.id)?.kind === 'package');
      if (!equal([...entry.originalTaskIds].sort(), productRetirements.map(item => item.id).sort())
        || !equal([...entry.replacementTaskIds].sort(), productRetirements.map(item => item.replacementId).sort())
        || !entry.originalTaskIds.some(id => (registeredVersions.get(id)?.revision ?? authorizations.get(id)?.manifest.revision) === entry.previous.registry.revision)) throw new Error('Package version task/freeze set differs');
      if (digest(io.fileAt(entry.previous.registry.revision, PACKAGES) ?? '') !== entry.previous.registry.sha256
        || digest(io.fileAt(activation, PACKAGES) ?? '') !== entry.next.registry.sha256) throw new Error('Package registry bytes differ');
      const next = jsonAt(PACKAGES, activation), oldPackage = before?.packages?.find(item => item.id === entry.packageId);
      const newPackage = next?.packages?.find(item => item.id === entry.packageId);
      if (!oldPackage || !newPackage || !hash(entry.previous.packageSha256) || !hash(entry.next.packageSha256)) throw new Error('Missing structural package version');
      // Use canonical equality through the shared helper, preserving nested fields.
      for (const id of entry.originalTaskIds) {
        const manifest = manifests.get(id), auth = authorizations.get(id);
        if (!transition.retirements.some(item => item.id === id) || manifest?.kind !== 'package' || manifest.package.id !== entry.packageId
          || manifest.packageSha256 !== entry.previous.packageSha256
          || !io.ancestor(entry.previous.registry.revision, registeredVersions.get(id)?.revision ?? auth.manifest.revision)) throw new Error('Original package identity differs');
        const registered = registeredVersions.get(id);
        const historical = jsonAt(PACKAGES, registered?.revision ?? auth.manifest.revision);
        if (registered && (registered.revision !== entry.previous.registry.revision
          || registered.registrySha256 !== entry.previous.registry.sha256
          || registered.packageSha256 !== entry.previous.packageSha256)) throw new Error('Prior replacement registry version substituted');
        if (!equal(structure(historical?.packages?.find(item => item.id === entry.packageId) ?? {}), structure(manifest.package))
          || !equal(structure(oldPackage), structure(manifest.package))) throw new Error('Original package was not registered at freeze');
        historicalPackagesByTask.set(id, historical.packages);
      }
      for (const output of entry.additions.emittedFiles) {
        const match = typeof output === 'string' && /^runtime\/(.+)\.js$/.exec(output);
        const source = match ? `src/${match[1]}.ts` : null;
        if (!source || !safePath(source) || !oldPackage.allowed_files.includes(source)
          || !entry.additions.allowed_files.includes(output) || io.fileAt(freeze, source) === null) {
          throw new Error('Added emission lacks a retained owned TypeScript source');
        }
      }
      const additionPaths = transition.additions.map(item => item.manifest.path);
      if (entry.additions.allowed_files.some(path => !safePath(path) || !additionPaths.includes(path)
        && !/^tests_js\/[^/]+\.mjs$/.test(path) && !entry.additions.emittedFiles.includes(path))) throw new Error('Registry delta adds unrelated ownership');
      const expected = { ...oldPackage, allowed_files: [...oldPackage.allowed_files, ...entry.additions.allowed_files],
        emittedFiles: [...oldPackage.emittedFiles, ...entry.additions.emittedFiles] };
      if (new Set(expected.allowed_files).size !== expected.allowed_files.length || new Set(expected.emittedFiles).size !== expected.emittedFiles.length
        || !equal(expected, newPackage)) throw new Error('Registry delta differs from additive ownership');
      for (const id of entry.replacementTaskIds) {
        const manifest = manifests.get(id);
        if (!transition.additions.some(item => item.id === id) || manifest?.kind !== 'package' || manifest.package.id !== entry.packageId
          || manifest.packageSha256 !== entry.next.packageSha256 || !equal(structure(manifest.package), structure(newPackage))) throw new Error('Replacement current package differs');
        registeredVersions.set(id, { revision: activation, registrySha256: entry.next.registry.sha256, packageSha256: entry.next.packageSha256 });
      }
    }
    if (entries.length) {
      const after = jsonAt(PACKAGES, activation);
      if (!closed(before, ['schemaVersion', 'packages']) || !closed(after, ['schemaVersion', 'packages']) || before.schemaVersion !== after.schemaVersion
        || !equal(before.packages.filter(item => !seen.has(item.id)), after.packages.filter(item => !seen.has(item.id)))) throw new Error('Unrelated package registry changed');
      registryActivations.set(activation, digest(io.fileAt(activation, PACKAGES)));
    }
    for (const retirement of transition.retirements) if (manifests.get(retirement.id)?.kind === 'package'
      && !historicalPackagesByTask.has(retirement.id)) throw new Error('Product retirement lacks historical registry');
  }
  for (const entry of shard.transitions) {
    const transition = await frozen(entry);
    contracts.push(transition);
    if (!binding(transition.previousDag) || !binding(transition.nextDag) || !Array.isArray(transition.additions)
      || !Array.isArray(transition.retirements) || !Array.isArray(transition.packageVersions)) throw new Error('Invalid transition documents');
    for (const archive of [transition.previousDag, transition.nextDag]) {
      dagsByHash.set(archive.sha256, assignmentsFrom(await frozen(archive))); planningBindings.set(archive.path, archive.sha256);
    }
    const activation = firstRecord('transitions', entry);
    activationByTransition.set(transition.id, activation);
    if (entry.revision === activation || !io.ancestor(entry.revision, activation)) throw new Error('Transition must freeze before activation');
    const preparation = prepared.get(entry.path);
    if (!preparation || preparation.revision !== entry.revision || preparation.sha256 !== entry.sha256) throw new Error('Transition lacks prior preparation');
    planningBindings.set(entry.path, entry.sha256);
    for (const addition of transition.additions) {
      const authorization = authorizations.get(addition.id);
      if (!authorization || !binding(addition.manifest) || !io.ancestor(addition.manifest.revision, entry.revision)
        || addition.manifest.revision === entry.revision || originalActivation(addition.id) !== activation) throw new Error('Replacement activated before reviewed transition');
      replacementActivations.set(addition.id, activation); transitionByTask.set(addition.id, transition.id);
    }
    const captures = new Map();
    for (const retirement of transition.retirements) if (retirement.attempt !== null) captures.set(retirement.id, await captureAttempt(retirement, transition, entry.revision));
    for (const retirement of transition.retirements) {
      const manifest = manifests.get(retirement.id);
      if (!manifest) throw new Error('Missing original manifest');
      const activation = originalActivation(retirement.id);
      const paths = [...manifest.package.allowed_files, ...manifest.cells.map(cell => cell.logPath), ...manifest.artifacts];
      const capture = captures.get(retirement.id);
      for (const path of paths) {
        if (COORDINATOR.has(path) || planningBindings.has(path) || path === authorizations.get(retirement.id).manifest.path
          || catalog.assignments.some(item => item.manifest.path === path) || catalog.audits.some(item => item.path === path)) continue;
        const revisions = changes(path).filter(revision => revision !== activation && io.ancestor(activation, revision) && io.ancestor(revision, entry.revision)
          && io.diff(activation, revision).some(change => change.path === path || change.oldPath === path));
        if (revisions.length && !capture && ![...captures.values()].some(shared => shared.covered.has(path)
          && revisions.every(revision => io.ancestor(revision, shared.evidenceCommit)))) throw new Error('Null attempt conceals historical work');
        if (capture && revisions.some(revision => !io.ancestor(revision, capture.evidenceCommit))) throw new Error('Attempt capture omits later work');
      }
      freezePoints.set(retirement.id, entry.revision);
    }
    for (const original of transition.retirements.filter(item => item.attempt !== null)) {
      const capture = original.attempt.capture, preparation = prepared.get(capture.path);
      const packageId = manifests.get(original.id).package.id;
      for (const addition of transition.additions.filter(item => manifests.get(item.id)?.package.id === packageId)) {
        const manifest = manifests.get(addition.id);
        if (!preparation || !io.ancestor(preparation.revision, manifest.base)
          || !manifest.inputs.some(input => equal(input, capture))) throw new Error('Every replacement role must bind the prepared capture base');
        for (const file of original.attempt.files) if (file.sha256 !== null && !planningBindings.has(file.path) && !COORDINATOR.has(file.path)) {
          if (!manifest.package.allowed_files.includes(file.path) || !manifest.inputs.some(input => equal(input, file))
            || digest(io.fileAt(manifest.base, file.path) ?? '') !== file.sha256) throw new Error('Replacement role drops adopted source binding');
        }
      }
    }
    validateVersions(transition, entry.revision, activation);
    const authorizedAtFreeze = new Set([...authorizations].filter(([, value]) => io.ancestor(value.manifest.revision, entry.revision)).map(([id]) => id));
    const receiptedAtFreeze = new Set();
    for (const revision of changes(RECEIPTS).filter(value => io.ancestor(value, entry.revision))) {
      for (const receipt of jsonAt(RECEIPTS, revision).receipts) receiptedAtFreeze.add(receipt.id);
    }
    const authorizedAtActivation = new Set([...authorizations].filter(([, value]) => io.ancestor(value.manifest.revision, activation)).map(([id]) => id));
    const receiptedAtActivation = new Set();
    for (const revision of changes(RECEIPTS).filter(value => io.ancestor(value, activation))) {
      for (const receipt of jsonAt(RECEIPTS, revision).receipts) receiptedAtActivation.add(receipt.id);
    }
    facts.set(transition.id, { immutable: true, beforeActivation: true, attemptsValid: true, versionsValid: true, historyValid: true,
      authorizedAtFreeze, receiptedAtFreeze, authorizedAtActivation, receiptedAtActivation });
  }
  for (const [id, manifest] of manifests) {
    const dag = dagsByHash.get(manifest.dag?.sha256);
    if (!dag || ![catalog.dag, ...contracts.map(item => item.nextDag)].some(item => item.path === manifest.dag.path && item.sha256 === manifest.dag.sha256)) throw new Error('Manifest archive is outside lineage');
    const authorization = authorizations.get(id);
    const ownAddition = contracts.find(transition => transition.additions.some(item => item.id === id && equal(item.manifest, authorization.manifest)));
    let effective = dagsByHash.get(catalog.dag.sha256);
    for (const transition of contracts) if (io.ancestor(activationByTransition.get(transition.id), authorization.manifest.revision)) {
      effective = dagsByHash.get(transition.nextDag.sha256);
    }
    if (ownAddition) {
      if (!equal(manifest.dag, { path: ownAddition.nextDag.path, sha256: ownAddition.nextDag.sha256 })) throw new Error('Addition must bind its exact reviewed next DAG');
    } else if (!equal(dag.get(id), effective.get(id))) throw new Error('Manifest binds an obsolete assignment at freeze');
    ownDagByTask.set(id, dag);
  }
  const resolved = validateTaskLineage({ preparations: shard.preparations, transitions: contracts }, {
    rootDag: catalog.dag, dagsByHash, manifests, authorizations, receiptIds, handoffTaskIds, facts, preparationFacts });
  if (resolved.errors.length) throw new Error(resolved.errors.join('; '));
  const capturedSuccessors = new Map();
  for (const transition of contracts) for (const retirement of transition.retirements) {
    const original = manifests.get(retirement.id), replacement = manifests.get(retirement.replacementId);
    const sources = retirement.attempt ? [retirement] : transition.retirements.filter(item => item.attempt
      && manifests.get(item.id).package.id === original.package.id);
    if (sources.length !== 1) continue;
    const attempt = sources[0].attempt;
    const capturedFiles = new Map(attempt.files.filter(item => item.sha256 !== null
      && original.package.allowed_files.includes(item.path) && !planningBindings.has(item.path) && !COORDINATOR.has(item.path)
      && replacement.inputs.some(input => equal(input, item))).map(item => [item.path, item.sha256]));
    capturedSuccessors.set(retirement.id, { replacementId: retirement.replacementId,
      subjectSha: attempt.subject.sha, manifestSha256: retirement.manifest.sha256,
      inputs: new Map(original.inputs.map(item => [item.path, item.sha256])), capturedFiles,
      allowedFiles: new Set(original.package.allowed_files), valid: true });
  }
  const allAssignments = new Map();
  for (const dag of dagsByHash.values()) for (const [id, value] of dag) allAssignments.set(id, value);
  if (io.head() !== head) throw new Error('HEAD changed during lineage validation');
  return { ...resolved, capturedSuccessors, allAssignments, ownDagByTask, historicalPackagesByTask, planningBindings, preservedFiles,
    replacementActivations, preservedLogHashes, transitionByTask, freezePoints,
    preparedPath: (path, revision) => {
      const item = prepared.get(path);
      return !!item && io.ancestor(item.revision, revision) && digest(io.fileAt(revision, path) ?? '') === item.sha256;
    },
    validateAt: revision => {
      const value = jsonAt(LINEAGE, revision);
      if (value === null) return;
      validShard(value);
      for (const key of ['preparations', 'transitions']) if (value[key].some(item => !shard[key].some(current => equal(current, item)))) throw new Error('Lineage snapshot differs');
    },
    registryAt: revision => registryActivations.has(revision) && registryActivations.get(revision) === digest(io.fileAt(revision, PACKAGES) ?? ''),
    registryChange: (base, revision) => [...registryActivations].some(([activation, expected]) => io.ancestor(base, activation)
      && io.ancestor(activation, revision) && digest(io.fileAt(revision, PACKAGES) ?? '') === expected),
  };
}
