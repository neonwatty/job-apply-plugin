import { implementationFor } from './task-lineage.mjs';
import { canonical, closed, digest, equal, hash, safePath, sha, strings } from './evidence-io.mjs';
import { parseTaskTap } from './tap-evidence.mjs';
import { sourceSizePath } from './task-manifests.mjs';

const fields = ['schemaVersion', 'id', 'manifestSha256', 'subject', 'executionBase', 'evidenceCommit', 'diff', 'files',
  'dependencies', 'cells', 'artifacts', 'review', 'status'];
const binding = item => closed(item, ['path', 'sha256']) && safePath(item.path) && hash(item.sha256);
const fileBinding = item => closed(item, ['path', 'sha256']) && safePath(item.path) && (hash(item.sha256) || item.sha256 === null);
const nonnegative = value => Number.isFinite(value) && value >= 0;

export function validateTaskReceipts(receipts, context) {
  let currentOpen = context?.pendingWork === true;
  const historicalAcceptedTasks = new Set();
  const errors = [], acceptedTasks = new Set(), acceptedPackages = new Set(), receiptDigests = new Map();
  const result = () => ({ errors, acceptedTasks, acceptedPackages, receiptDigests, historicalAcceptedTasks, currentAcceptance: errors.length ? 'invalid' : currentOpen || !acceptedTasks.size ? 'open' : 'accepted' });
  if (!Array.isArray(receipts)) { errors.push('Task receipts must be an array'); return result(); }
  for (const key of ['manifests', 'manifestHashes', 'assignments', 'environments', 'facts']) {
    if (!(context?.[key] instanceof Map)) errors.push(`Missing task receipt registry ${key}`);
  }
  if (context?.clean !== true) errors.push('Task evidence requires a clean tracked checkout');
  if (errors.length) return result();
  const byId = new Map();
  const candidates = new Map(receipts.filter(item => item && typeof item.id === 'string').map(item => [item.id, item]));
  function depends(id, predecessor, seen = new Set()) {
    if (seen.has(id)) return false;
    seen.add(id);
    return (context.assignments.get(id)?.dependencies ?? []).some(dep => dep === predecessor || depends(dep, predecessor, seen));
  }
  function currentOrSuccessor(id, path, expected, seen = new Set()) {
    const fact = context.facts.get(id);
    if (fact?.currentFiles.get(path) === expected || fact?.metadataInputs?.has(path)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    for (const [nextId, candidate] of candidates) {
      const next = context.manifests.get(nextId), nextFact = context.facts.get(nextId);
      if (context.manifests.get(id)?.kind === 'package' && next?.kind !== 'package') continue;
      if (!next?.package.allowed_files.includes(path) || !next.inputs.some(input => input.path === path && input.sha256 === expected)
        || !depends(nextId, id) || !nextFact?.predecessorSubjects?.has(candidates.get(id)?.subject?.sha)) continue;
      const successor = Array.isArray(candidate.files) && candidate.files.find(file => file?.path === path);
      if (successor && nextFact.subjectFiles.get(path) === successor.sha256
        && currentOrSuccessor(nextId, path, successor.sha256, new Set(seen))) return true;
    }
    for (const [nextId, pending] of context.pendingSuccessors ?? []) {
      const next = context.manifests.get(nextId);
      if (context.manifests.get(id)?.kind === 'package' && next?.kind !== 'package') continue;
      if (next?.package.allowed_files.includes(path) && next.inputs.some(input => input.path === path && input.sha256 === expected)
        && depends(nextId, id) && pending.predecessorSubjects.has(candidates.get(id)?.subject?.sha) && pending.changedPaths.has(path)) {
        currentOpen = true; return true;
      }
    }
    return false;
  }
  for (const receipt of receipts) {
    if (!closed(receipt, fields)) { errors.push('Invalid task receipt fields'); continue; }
    const fail = message => errors.push(`${receipt.id}: ${message}`);
    if (receipt.schemaVersion !== 1 || byId.has(receipt.id) || receipt.status !== 'passed') fail('invalid/duplicate receipt ID or status');
    byId.set(receipt.id, receipt);
    const manifest = context.manifests.get(receipt.id), fact = context.facts.get(receipt.id);
    if (!manifest || !fact || !hash(receipt.manifestSha256) || receipt.manifestSha256 !== context.manifestHashes.get(receipt.id)) {
      fail('missing frozen manifest/facts'); continue;
    }
    if (!closed(receipt.subject, ['sha', 'tree']) || !sha(receipt.subject.sha) || !sha(receipt.subject.tree)
      || !sha(receipt.executionBase) || fact.executionBase !== receipt.executionBase || !fact.planningValid
      || !sha(receipt.evidenceCommit) || fact.subjectTree !== receipt.subject.tree || !fact.ancestry
      || !fact.immutableManifest || !fact.revisionsKnown) { fail('wrong immutable subject/tree/evidence ancestry'); continue; }
    const review = receipt.review;
    if (!closed(review, ['author', 'reviewer', 'subjectSha', 'subjectTree', 'manifestSha256', 'decision'])
      || review.author !== manifest.author || review.reviewer !== manifest.reviewer || review.author.trim() === review.reviewer.trim()
      || review.subjectSha !== receipt.subject.sha || review.subjectTree !== receipt.subject.tree
      || review.manifestSha256 !== receipt.manifestSha256 || review.decision !== 'approved') fail('review is not independent and exact-subject bound');
    const allowed = manifest.package.allowed_files;
    if (!Array.isArray(receipt.diff) || !equal(receipt.diff, fact.diff)) { fail('actual Git diff differs'); continue; }
    else for (const change of receipt.diff) {
      if (!closed(change, ['status', 'oldPath', 'path']) || !['A', 'M', 'D', 'R'].includes(change.status)
        || !safePath(change.path) || !allowed.includes(change.path) && !fact.coordinatorChanges?.has(change.path)
        || (change.status === 'R' ? !safePath(change.oldPath) || !allowed.includes(change.oldPath) : change.oldPath !== null)) fail('out-of-scope change/rename/delete');
    }
    if (!Array.isArray(receipt.files) || !receipt.files.every(fileBinding)
      || !equal(receipt.files.map(file => file.path).sort(), [...allowed].sort())) fail('file bindings differ from exact ownership');
    else for (const file of receipt.files) {
      if (fact.subjectFiles.get(file.path) !== file.sha256 || !currentOrSuccessor(receipt.id, file.path, file.sha256)) fail('dirty/stale/untracked subject file');
      const lines = fact.subjectLines.get(file.path) ?? 0;
      const old = manifest.oversized.find(item => item.path === file.path);
      if (sourceSizePath(file.path)) {
        if (lines > (old ? Math.min(old.ceiling, old.baselineLines) : 500)) fail('source size ceiling exceeded');
        const nextCeiling = fact.subjectCeilings.get(file.path);
        if (old && (lines <= 500 ? nextCeiling !== undefined : nextCeiling === undefined || nextCeiling < lines
          || nextCeiling > old.ceiling || lines < old.baselineLines && nextCeiling >= old.ceiling)) fail('oversized baseline did not shrink/remove');
        if (!old && nextCeiling !== undefined) fail('new source-size exception');
      }
      if (file.sha256 === null && !receipt.diff.some(change => change.status === 'D' && change.path === file.path
        || change.status === 'R' && change.oldPath === file.path)) fail('missing owned file without deletion');
    }
    for (const input of manifest.inputs) if (!allowed.includes(input.path)
      && (!currentOrSuccessor(receipt.id, input.path, input.sha256) || fact.subjectFiles.get(input.path) !== input.sha256 && !fact.metadataInputs?.has(input.path))) fail('stale immutable input');
    if (!Array.isArray(receipt.artifacts) || !receipt.artifacts.every(binding)
      || !equal(receipt.artifacts.map(item => item.path).sort(), [...manifest.artifacts].sort())) fail('required artifact bindings differ');
    else for (const item of receipt.artifacts) {
      if (fact.evidenceFiles.get(item.path) !== item.sha256 || fact.currentFiles.get(item.path) !== item.sha256) fail('uncommitted/stale artifact');
    }
    if (!Array.isArray(receipt.cells) || !equal(receipt.cells.map(cell => cell?.id).sort(), manifest.cells.map(cell => cell.id).sort())) {
      fail('required execution cells differ'); continue;
    }
    const logPaths = new Set();
    for (const cell of receipt.cells) {
      const declaration = manifest.cells.find(item => item.id === cell?.id);
      if (!closed(cell, ['id', 'environment', 'command', 'result', 'log']) || !declaration
        || !equal(cell.environment, context.environments.get(declaration.environmentId))
        || !equal(cell.command, declaration.command)) { fail('cell command/environment identity differs'); continue; }
      const observed = cell.result;
      if (!closed(observed, ['exitCode', 'timedOut', 'durationMs', 'outputBytes', 'tests', 'failures', 'skips', 'cancelled', 'todo'])
        || observed.exitCode !== 0 || observed.timedOut !== false || !nonnegative(observed.durationMs)
        || observed.durationMs > declaration.timeoutMs || !Number.isSafeInteger(observed.outputBytes) || observed.outputBytes <= 0
        || observed.outputBytes > declaration.maxOutputBytes || !Number.isSafeInteger(observed.tests) || observed.tests <= 0
        || ['failures', 'skips', 'cancelled', 'todo'].some(key => observed[key] !== 0)) { fail('unsuccessful/skipped/timed out or over-budget cell'); continue; }
      if (!binding(cell.log) || cell.log.path !== declaration.logPath || logPaths.has(cell.log.path) || allowed.includes(cell.log.path) || manifest.artifacts.includes(cell.log.path)) {
        fail('invalid/duplicate log binding'); continue;
      }
      logPaths.add(cell.log.path);
      const log = fact.logs.get(cell.log.path);
      if (typeof log !== 'string' || digest(log) !== cell.log.sha256 || Buffer.byteLength(log) !== observed.outputBytes
        || fact.evidenceFiles.get(cell.log.path) !== cell.log.sha256 || fact.currentFiles.get(cell.log.path) !== cell.log.sha256) fail('log is not immutable/current evidence');
      const tap = parseTaskTap(log);
      if (!tap || !equal(tap.names, declaration.testNames) || tap.tests !== observed.tests
        || tap.durationMs > declaration.timeoutMs || observed.durationMs + 1 < tap.durationMs) fail('observed TAP identities differ or reporter unsupported');
    }
    const dependencies = context.assignments.get(receipt.id)?.dependencies;
    if (!strings(dependencies, true) || !Array.isArray(receipt.dependencies)
      || !receipt.dependencies.every(item => closed(item, ['id', 'sha256']) && hash(item.sha256))
      || !equal(receipt.dependencies.map(item => item.id).sort(), [...dependencies].sort())) fail('approved DAG dependencies omitted/changed');
    receiptDigests.set(receipt.id, digest(canonical(receipt)));
  }
  for (const receipt of byId.values()) {
    if (!Array.isArray(receipt.dependencies)) continue;
    if (context.assignments.get(receipt.id)?.role === 'independent-review') {
      try { implementationFor(context.ownDagByTask?.get(receipt.id) ?? context.assignments, receipt.id); }
      catch (error) { errors.push(`${receipt.id}: ${error.message}`); continue; }
    }
    for (const dep of receipt.dependencies) {
      const previous = byId.get(dep?.id);
      if (!previous || dep.sha256 !== receiptDigests.get(dep.id)) errors.push(`${receipt.id}: missing/stale dependency receipt`);
      if (context.assignments.get(receipt.id)?.role === 'independent-review'
        && dep?.id === implementationFor(context.ownDagByTask?.get(receipt.id) ?? context.assignments, receipt.id)
        && !equal(previous?.subject, receipt.subject)) errors.push(`${receipt.id}: review subject differs from implementation`);
    }
  }
  if (errors.length) { receiptDigests.clear(); return result(); }
  for (const receipt of byId.values()) historicalAcceptedTasks.add(receipt.id);
  if (currentOpen) return result();
  for (const receipt of byId.values()) {
    acceptedTasks.add(receipt.id);
    const manifest = context.manifests.get(receipt.id);
    if (manifest.kind === 'package' && manifest.role === 'independent-review') acceptedPackages.add(manifest.package.id);
  }
  return result();
}
