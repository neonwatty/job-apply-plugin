import { canonical, closed, digest, equal, hash, safePath, text } from './evidence-io.mjs';

const fields = ['schemaVersion', 'id', 'predecessorPackageId', 'predecessorPackageSha256',
  'predecessorReviewTaskId', 'predecessorReceiptSha256', 'successorPackageId', 'successorPackageSha256',
  'successorTaskId', 'successorManifestSha256', 'paths', 'author', 'reviewer', 'decision'];
const structureHash = ({ status, ...value }) => digest(canonical(value));
function depends(assignments, id, predecessor, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  return (assignments.get(id)?.dependencies ?? []).some(dep => dep === predecessor || depends(assignments, dep, predecessor, seen));
}

// Input facts are supplied by the immutable loader, never by receipt JSON.
export function validateTaskHandoffs(contracts, context) {
  const errors = [], ownershipHandoffs = [], historicalReadiness = new Map();
  const empty = () => ({ errors, ownershipHandoffs: [], historicalReadiness: new Map() });
  if (!Array.isArray(contracts)) { errors.push('Handoffs must be an array'); return empty(); }
  for (const key of ['packages', 'manifests', 'manifestHashes', 'assignments', 'receiptDigests', 'receipts', 'facts']) {
    if (!(context?.[key] instanceof Map)) errors.push(`Missing handoff registry ${key}`);
  }
  if (!(context?.historicalAcceptedTasks instanceof Set)) errors.push('Missing verified historical tasks');
  if (errors.length) return empty();
  const ids = new Set(), owners = new Set();
  for (const contract of contracts) {
    if (!closed(contract, fields)) { errors.push('Invalid handoff fields'); continue; }
    const fail = message => errors.push(`${contract.id}: ${message}`);
    if (contract.schemaVersion !== 1 || !text(contract.id) || ids.has(contract.id)) fail('invalid/duplicate handoff identity');
    ids.add(contract.id);
    const predecessor = context.packages.get(contract.predecessorPackageId), successor = context.packages.get(contract.successorPackageId);
    const manifest = context.manifests.get(contract.successorTaskId), priorManifest = context.manifests.get(contract.predecessorReviewTaskId);
    const fact = context.facts.get(contract.id), prior = context.receipts.get(contract.predecessorReviewTaskId);
    if (!predecessor || !successor || !manifest || !priorManifest || !fact || !prior) { fail('unknown handoff package/task/facts'); continue; }
    if (predecessor.id === successor.id || predecessor.status !== 'implemented'
      || !['planned', 'ready', 'implemented'].includes(successor.status)
      || structureHash(predecessor) !== contract.predecessorPackageSha256 || structureHash(successor) !== contract.successorPackageSha256) fail('structural package identity differs');
    if (priorManifest.kind !== 'package' || priorManifest.role !== 'independent-review' || priorManifest.package.id !== predecessor.id
      || !context.historicalAcceptedTasks.has(contract.predecessorReviewTaskId)
      || context.receiptDigests.get(contract.predecessorReviewTaskId) !== contract.predecessorReceiptSha256) fail('predecessor lacks exact verified product review');
    if (manifest.kind !== 'package' || manifest.role !== 'implementation-or-gate' || manifest.package.id !== successor.id
      || context.manifestHashes.get(contract.successorTaskId) !== contract.successorManifestSha256
      || !successor.dependencies.includes(predecessor.id)
      || !depends(context.assignments, contract.successorTaskId, contract.predecessorReviewTaskId)) fail('successor authorization/dependency differs');
    if (contract.author !== manifest.author || contract.author !== successor.owner || contract.reviewer !== manifest.reviewer
      || contract.author === contract.reviewer || contract.decision !== 'approved') fail('handoff review is not independently authorized');
    if (!fact.immutable || !fact.beforeExecution || !fact.predecessorAncestry || !fact.predecessorReadyAtFreeze) fail('handoff is not immutable before execution');
    const overlap = predecessor.allowed_files.filter(path => successor.allowed_files.includes(path)).sort();
    if (!Array.isArray(contract.paths) || !contract.paths.length
      || !contract.paths.every(item => closed(item, ['path', 'sha256']) && safePath(item.path) && hash(item.sha256))
      || !equal(contract.paths.map(item => item.path).sort(), overlap)) { fail('handoff paths differ from exact overlap'); continue; }
    for (const item of contract.paths) {
      const key = `${predecessor.id}\0${item.path}`;
      if (owners.has(key)) fail('competing successor for predecessor path');
      owners.add(key);
      if (fact.predecessorFiles.get(item.path) !== item.sha256 || fact.successorBaseFiles.get(item.path) !== item.sha256
        || !manifest.inputs.some(input => input.path === item.path && input.sha256 === item.sha256)) fail('handoff input bytes differ');
    }
    if (successor.status === 'planned') continue;
    ownershipHandoffs.push({ predecessorPackageId: predecessor.id, successorPackageId: successor.id, paths: contract.paths.map(item => item.path) });
    if (!historicalReadiness.has(successor.id)) historicalReadiness.set(successor.id, new Set());
    historicalReadiness.get(successor.id).add(predecessor.id);
  }
  return errors.length ? empty() : { errors, ownershipHandoffs, historicalReadiness };
}
