import { closed, equal, hash, safePath, sha, strings, text } from './evidence-io.mjs';

export const binding = value => closed(value, ['path', 'sha256', 'revision'])
  && safePath(value.path) && hash(value.sha256) && sha(value.revision);
export const fileBinding = value => closed(value, ['path', 'sha256']) && safePath(value.path) && hash(value.sha256);
const authority = value => value.author === 'root' && value.reviewer === 'hooks_audit' && text(value.reason);
export const preparationPath = path => safePath(path) && /^docs\/migration\/evidence\/.+\.(json|md)$/.test(path);
const fields = ['schemaVersion', 'id', 'previousDag', 'nextDag', 'retirements', 'additions', 'refinements',
  'packageVersions', 'witnessMappings', 'author', 'reviewer', 'decision', 'reason'];

export function assignmentsFrom(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Empty approved task DAG');
  const result = new Map();
  for (const item of value) {
    if (!closed(item, ['id', 'package', 'role', 'dependencies']) || !text(item.id) || !text(item.package)
      || !['reference', 'implementation-or-gate', 'independent-review'].includes(item.role)
      || !strings(item.dependencies, true) || result.has(item.id)) throw new Error('Invalid approved DAG assignment');
    result.set(item.id, item);
  }
  const seen = new Set(), visiting = new Set();
  function visit(id) {
    if (!result.has(id) || visiting.has(id)) throw new Error('Unknown/cyclic approved dependency');
    if (seen.has(id)) return;
    visiting.add(id);
    for (const dep of result.get(id).dependencies) visit(dep);
    visiting.delete(id); seen.add(id);
  }
  for (const id of result.keys()) visit(id);
  return result;
}
export function ancestors(dag, id, result = new Set()) {
  for (const dep of dag.get(id)?.dependencies ?? []) if (!result.has(dep)) { result.add(dep); ancestors(dag, dep, result); }
  return result;
}
export function implementationFor(dag, reviewId) {
  const review = dag.get(reviewId);
  const ids = (review?.dependencies ?? []).filter(id => dag.get(id)?.package === review.package
    && dag.get(id)?.role === 'implementation-or-gate');
  if (ids.length !== 1) throw new Error('Review needs exactly one direct same-package implementation dependency');
  return ids[0];
}

// Facts are obtained by the immutable loader. This function grants no acceptance.
export function validateTaskLineage(value, context) {
  const errors = [];
  const empty = () => ({ errors, dagsByHash: new Map(), activeAssignments: new Map(), retiredTasks: new Set(), replacements: new Map() });
  try {
    if (!closed(value, ['preparations', 'transitions']) || !Array.isArray(value.preparations) || !Array.isArray(value.transitions)) throw new Error('Invalid lineage collections');
    for (const key of ['dagsByHash', 'manifests', 'authorizations', 'facts', 'preparationFacts']) {
      if (!(context?.[key] instanceof Map)) throw new Error(`Missing lineage registry ${key}`);
    }
    if (!binding(context.rootDag) || !(context.receiptIds instanceof Set) || !(context.handoffTaskIds instanceof Set)) throw new Error('Missing lineage roots/history');
    const ids = new Set(), paths = new Set();
    for (const item of value.preparations) {
      if (!closed(item, ['id', 'author', 'reviewer', 'reason', 'files']) || !text(item.id) || ids.has(item.id)
        || !authority(item) || !Array.isArray(item.files) || !item.files.length) throw new Error('Invalid preparation authorization');
      ids.add(item.id);
      for (const file of item.files) {
        if (!fileBinding(file) || !preparationPath(file.path) || paths.has(file.path)) throw new Error('Invalid/duplicate preparation path');
        paths.add(file.path);
      }
      const fact = context.preparationFacts.get(item.id);
      if (!fact?.filesValid || !fact?.historyValid) throw new Error('Preparation files/history differ');
    }
    let previous = context.rootDag;
    let dag = context.dagsByHash.get(previous.sha256);
    if (!(dag instanceof Map)) throw new Error('Missing root DAG');
    const retiredTasks = new Set(), replacements = new Map(), usedIds = new Set(dag.keys());
    const terminals = [...dag.keys()].filter(id => ![...dag.values()].some(item => item.dependencies.includes(id)));
    const obligations = new Map(terminals.map(id => [id, ancestors(dag, id)]));
    function mapped(id) {
      const seen = new Set();
      while (replacements.has(id)) {
        if (seen.has(id)) throw new Error('Replacement cycle');
        seen.add(id); id = replacements.get(id);
      }
      return id;
    }
    for (const transition of value.transitions) {
      if (!closed(transition, fields) || transition.schemaVersion !== 1 || !text(transition.id) || ids.has(transition.id)
        || !authority(transition) || transition.decision !== 'approved' || !binding(transition.previousDag)
        || !binding(transition.nextDag) || !equal(transition.previousDag, previous)
        || transition.nextDag.sha256 === previous.sha256) throw new Error('Competing/invalid lineage transition');
      ids.add(transition.id);
      for (const key of ['retirements', 'additions', 'refinements', 'packageVersions', 'witnessMappings']) {
        if (!Array.isArray(transition[key])) throw new Error('Invalid transition list');
      }
      const fact = context.facts.get(transition.id);
      if (!fact?.immutable || !fact?.beforeActivation || !fact?.attemptsValid || !fact?.versionsValid || !fact?.historyValid) throw new Error('Unverified lineage facts');
      const next = context.dagsByHash.get(transition.nextDag.sha256);
      if (!(next instanceof Map)) throw new Error('Missing next archived DAG');
      const newIds = new Set(), retiring = new Set(), refinementIds = new Set();
      for (const addition of transition.additions) {
        if (!closed(addition, ['id', 'manifest']) || !binding(addition.manifest) || usedIds.has(addition.id) || newIds.has(addition.id)
          || !next.has(addition.id) || !equal(context.authorizations.get(addition.id)?.manifest, addition.manifest)) throw new Error('Invalid new task identity');
        const manifest = context.manifests.get(addition.id);
        if (!manifest || !equal(manifest.dag, { path: transition.nextDag.path, sha256: transition.nextDag.sha256 })) throw new Error('Replacement manifest DAG differs');
        newIds.add(addition.id);
      }
      const targets = new Set();
      for (const retirement of transition.retirements) {
        if (!closed(retirement, ['id', 'manifest', 'replacementId', 'attempt']) || !binding(retirement.manifest)
          || !dag.has(retirement.id) || retiredTasks.has(retirement.id) || retiring.has(retirement.id)
          || !newIds.has(retirement.replacementId) || targets.has(retirement.replacementId)
          || !equal(context.authorizations.get(retirement.id)?.manifest, retirement.manifest)
          || context.receiptIds.has(retirement.id) || context.handoffTaskIds.has(retirement.id)) throw new Error('Cannot retire bound/receipted/competing task');
        const old = context.manifests.get(retirement.id), replacement = context.manifests.get(retirement.replacementId);
        if (!old || !replacement || old.kind !== replacement.kind || old.role !== replacement.role
          || old.author !== replacement.author || old.reviewer !== replacement.reviewer
          || old.package.id !== replacement.package.id || dag.get(retirement.id).role !== next.get(retirement.replacementId).role
          || dag.get(retirement.id).package !== next.get(retirement.replacementId).package) throw new Error('Replacement changes package/role/form');
        if (old.package.owner !== replacement.package.owner || old.package.activation !== replacement.package.activation) throw new Error('Replacement changes package ownership/activation');
        for (const field of ['allowed_files', 'emittedFiles', 'dependencies', 'requirementIds', 'interfaceIds', 'referenceIds', 'surfaceIds']) {
          if (!Array.isArray(old.package[field]) || !Array.isArray(replacement.package[field])
            || old.package[field].some(value => !replacement.package[field].includes(value))) throw new Error('Replacement drops original package obligations');
        }
        if (!equal(old.artifacts, replacement.artifacts)) throw new Error('Replacement drops artifacts');
        retiring.add(retirement.id); targets.add(retirement.replacementId);
        replacements.set(retirement.id, retirement.replacementId);
      }
      for (const refinement of transition.refinements) {
        if (!closed(refinement, ['id', 'beforeDependencies', 'afterDependencies']) || refinementIds.has(refinement.id)
          || !dag.has(refinement.id) || !next.has(refinement.id)
          || !(fact.authorizedAtFreeze instanceof Set) || !(fact.receiptedAtFreeze instanceof Set)
          || !(fact.authorizedAtActivation instanceof Set) || !(fact.receiptedAtActivation instanceof Set)
          || fact.authorizedAtFreeze.has(refinement.id) || fact.receiptedAtFreeze.has(refinement.id)
          || fact.authorizedAtActivation.has(refinement.id) || fact.receiptedAtActivation.has(refinement.id) || !equal(dag.get(refinement.id).dependencies, refinement.beforeDependencies)
          || !equal(next.get(refinement.id).dependencies, refinement.afterDependencies)) throw new Error('Invalid frozen consumer refinement');
        refinementIds.add(refinement.id);
      }
      for (const [id, original] of dag) {
        const current = next.get(id);
        if (!current || original.role !== current.role || original.package !== current.package
          || !refinementIds.has(id) && !equal(original, current)) throw new Error('Historical assignment changed');
        if (refinementIds.has(id) && original.dependencies.some(dep => !ancestors(next, id).has(mapped(dep)))) throw new Error('Refinement weakens prerequisites');
      }
      if ([...next.keys()].some(id => !dag.has(id) && !newIds.has(id))) throw new Error('Undeclared added assignment');
      const mappedCells = new Set();
      for (const mapping of transition.witnessMappings) {
        if (!closed(mapping, ['originalTaskId', 'replacementTaskId', 'originalCellId', 'replacementCellId'])
          || !retiring.has(mapping.originalTaskId) || replacements.get(mapping.originalTaskId) !== mapping.replacementTaskId) throw new Error('Invalid witness mapping');
        const old = context.manifests.get(mapping.originalTaskId)?.cells.find(cell => cell.id === mapping.originalCellId);
        const replacement = context.manifests.get(mapping.replacementTaskId)?.cells.find(cell => cell.id === mapping.replacementCellId);
        const key = `${mapping.originalTaskId}\0${mapping.originalCellId}`;
        if (old && replacement && !equal(old.command, replacement.command)
          && !context.manifests.get(mapping.replacementTaskId).package.allowed_files.includes(replacement.command?.[2])) throw new Error('Changed witness must be owned by replacement');
        if (!old || !replacement || mappedCells.has(key) || !equal([...old.testNames].sort(), [...replacement.testNames].sort())
          || !equal([...old.requirementIds].sort(), [...replacement.requirementIds].sort()) || old.environmentId !== replacement.environmentId
          || replacement.timeoutMs > old.timeoutMs || replacement.maxOutputBytes > old.maxOutputBytes || old.logPath === replacement.logPath) throw new Error('Witness obligation weakened');
        mappedCells.add(key);
      }
      for (const id of retiring) {
        const old = context.manifests.get(id);
        if (old.cells.some(cell => !mappedCells.has(`${id}\0${cell.id}`))
          || dag.get(id).dependencies.some(dep => !ancestors(next, mapped(id)).has(mapped(dep)))) throw new Error('Replacement loses required witness/prerequisite');
        retiredTasks.add(id);
      }
      for (const [terminal, required] of obligations) {
        if (!next.has(terminal) || retiredTasks.has(terminal)) throw new Error('Final gate identity changed');
        const actual = ancestors(next, terminal);
        if ([...required].some(id => !actual.has(mapped(id)))) throw new Error('Final gate ancestor obligation lost');
        for (const id of actual) required.add(id);
      }
      for (const id of newIds) {
        if (!terminals.some(terminal => ancestors(next, terminal).has(id))) throw new Error('Added task disconnected from final gate');
        const assignment = next.get(id);
        if (assignment.role === 'independent-review') implementationFor(next, id);
        usedIds.add(id);
      }
      previous = transition.nextDag; dag = next;
    }
    return { errors, dagsByHash: context.dagsByHash, activeAssignments: new Map([...dag].filter(([id]) => !retiredTasks.has(id))), retiredTasks, replacements };
  } catch (error) { errors.push(error.message); return empty(); }
}
