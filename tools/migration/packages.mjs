// Structural package schema only; implemented never means behaviorally accepted.
// Closed fields: id, parentNode, owner, allowed_files, surfaceIds, requirementIds,
// dependencies (package IDs), interfaceIds, referenceIds, emittedFiles,
// activation (inert), status (planned|ready|implemented).
// Context registries: nodes, surfaces, requirements, sourcePaths,
// acceptedInterfaces, acceptedReferences, acceptedPackages. Optional knownInterfaces
// and knownReferences admit planned prerequisites awaiting acceptance.
const FIELDS = ['id', 'parentNode', 'owner', 'allowed_files', 'surfaceIds',
  'requirementIds', 'dependencies', 'interfaceIds', 'referenceIds', 'emittedFiles',
  'activation', 'status'];
const LISTS = ['allowed_files', 'surfaceIds', 'requirementIds', 'dependencies',
  'interfaceIds', 'referenceIds', 'emittedFiles'];
const safePath = (value) => typeof value === 'string' && value.length > 0
  && !value.startsWith('/') && !value.includes('\\') && !value.includes(':')
  && !/[\x00-\x1f\x7f*?\[\]{}]/.test(value)
  && !value.split('/').some((part) => ['', '.', '..', '.git'].includes(part));
const text = (value) => typeof value === 'string' && value.trim().length > 0;

export function validatePackages(packages, context) {
  const errors = [];
  if (!Array.isArray(packages)) return ['Packages must be an array'];
  for (const field of ['nodes', 'surfaces', 'requirements', 'sourcePaths',
    'acceptedInterfaces', 'acceptedReferences', 'acceptedPackages', 'requiredRequirements']) {
    if (!(context?.[field] instanceof Set)) errors.push(`Missing context registry ${field}`);
  }
  if (!(context?.referenceRequirements instanceof Map)) errors.push('Missing reference requirement bindings');
  for (const field of ['knownInterfaces', 'knownReferences', 'releasedPackages']) {
    if (context?.[field] !== undefined && !(context[field] instanceof Set)) {
      errors.push(`Invalid context registry ${field}`);
    }
  }
  if (errors.length) return errors;
  const byId = new Map();
  const structurallyValid = [];
  for (const item of packages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push('Package must be an object');
      continue;
    }
    const label = text(item.id) ? item.id : '<invalid>';
    if (Object.keys(item).length !== FIELDS.length || FIELDS.some((field) => !Object.hasOwn(item, field))) {
      errors.push(`Invalid package fields ${label}`);
    }
    if (!text(item.id) || byId.has(item.id)) errors.push(`Invalid/duplicate package ID ${label}`);
    else byId.set(item.id, item);
    if (!text(item.owner)) errors.push(`Missing owner ${label}`);
    if (!context.nodes.has(item.parentNode)) errors.push(`Unknown parent node ${label}`);
    if (!['planned', 'ready', 'implemented'].includes(item.status)) errors.push(`Unsupported status ${label}`);
    if (item.activation !== 'inert') errors.push(`Unsupported activation ${label}`);
    let validLists = true;
    for (const field of LISTS) {
      const list = item[field];
      if (!Array.isArray(list) || list.some((value) => !text(value)) || new Set(list).size !== list.length) {
        errors.push(`Invalid/duplicate ${field} ${label}`);
        validLists = false;
      }
    }
    if (!validLists) continue;
    structurallyValid.push(item);
    if (!item.allowed_files.length) errors.push(`Empty file ownership ${label}`);
    for (const file of [...item.allowed_files, ...item.emittedFiles]) {
      if (!safePath(file)) errors.push(`Unsafe file path ${label}`);
    }
    for (const file of item.emittedFiles) {
      if (!item.allowed_files.includes(file)) errors.push(`Emission outside ownership ${label}:${file}`);
    }
    for (const [field, registry] of [
      ['surfaceIds', context.surfaces], ['requirementIds', context.requirements],
      ['referenceIds', context.knownReferences ?? context.acceptedReferences],
      ['interfaceIds', context.knownInterfaces ?? context.acceptedInterfaces],
    ]) {
      for (const id of item[field]) if (!registry.has(id)) errors.push(`Unknown ${field} ${label}:${id}`);
    }
    if (item.status === 'implemented') {
      for (const file of item.allowed_files) {
        if (!context.sourcePaths.has(file)) errors.push(`Missing implemented file ${label}:${file}`);
      }
    }
    if (['ready', 'implemented'].includes(item.status)) {
      if (!item.surfaceIds.length || !item.requirementIds.length) errors.push(`Missing readiness coverage ${label}`);
      if (!item.referenceIds.length) errors.push(`Missing accepted reference ${label}`);
      for (const id of item.referenceIds) {
        if (!context.acceptedReferences.has(id)) errors.push(`Unaccepted reference ${label}:${id}`);
      }
      for (const id of item.requirementIds) {
        if (context.requiredRequirements.has(id) && !item.referenceIds.some((reference) =>
          context.acceptedReferences.has(reference) && context.referenceRequirements.get(reference)?.has(id))) {
          errors.push(`Reference does not cover required scenario ${label}:${id}`);
        }
      }
      for (const id of item.interfaceIds) {
        if (!context.acceptedInterfaces.has(id)) errors.push(`Unaccepted interface ${label}:${id}`);
      }
    }
  }
  const owners = new Map();
  for (const id of context.releasedPackages ?? []) {
    if (!context.acceptedPackages.has(id) || byId.get(id)?.status !== 'implemented') {
      errors.push(`Cannot release unaccepted package ownership ${id}`);
    }
  }
  for (const item of structurallyValid) {
    for (const id of item.dependencies) {
      if (!byId.has(id)) errors.push(`Unknown dependency ${item.id}:${id}`);
      else if (['ready', 'implemented'].includes(item.status)
        && (byId.get(id).status !== 'implemented' || !context.acceptedPackages.has(id))) {
        errors.push(`Unaccepted dependency ${item.id}:${id}`);
      }
    }
    if (!['ready', 'implemented'].includes(item.status) || context.releasedPackages?.has(item.id)) continue;
    for (const file of item.allowed_files) {
      if (owners.has(file)) errors.push(`Overlapping ownership ${file}:${owners.get(file)}:${item.id}`);
      else owners.set(file, item.id);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { errors.push(`Package dependency cycle ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    const dependencies = byId.get(id)?.dependencies;
    if (Array.isArray(dependencies)) {
      for (const dependency of dependencies) if (byId.has(dependency)) visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id);
  return errors;
}
