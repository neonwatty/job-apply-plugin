// Requirements describe the work to verify. They never grant passing evidence.
const CATEGORIES = new Set(['valid', 'invalid', 'missing', 'noop', 'privacy',
  'conflict', 'concurrency', 'interruption', 'recovery', 'platform']);
const fields = ['id', 'surfaceIds', 'family', 'category', 'applicability',
  'platformCells', 'oracleFiles', 'testBindings', 'expectedArtifacts'];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
const list = (value) => Array.isArray(value) && value.length > 0
  && value.every(nonempty) && new Set(value).size === value.length;

// Context uses concrete registries: surfaces/nodes/platforms are Sets,
// files is Map(path, sha256), suites is Map(suiteId, Set(exact test paths)),
// testIds is Map(test path, Set(statically declared literal test names)).
export function validateRequirements(requirements, context) {
  if (!Array.isArray(requirements)) return ['Requirements must be an array'];
  for (const key of ['nodes', 'surfaces', 'platforms']) {
    if (!(context?.[key] instanceof Set)) return [`Missing requirement registry ${key}`];
  }
  for (const key of ['files', 'suites', 'testIds']) {
    if (!(context?.[key] instanceof Map)) return [`Missing requirement registry ${key}`];
  }
  const errors = [];
  const seen = new Set();
  for (const item of requirements) {
    if (!closed(item, fields)) { errors.push('Invalid requirement fields'); continue; }
    const fail = (message) => errors.push(`${item.id}: ${message}`);
    if (!nonempty(item.id) || seen.has(item.id)) fail('invalid/duplicate requirement ID');
    seen.add(item.id);
    if (!context.nodes.has(item.family)) fail('unknown family');
    if (!CATEGORIES.has(item.category)) fail('unknown scenario category');
    if (!list(item.surfaceIds) || item.surfaceIds.some((id) => !context.surfaces.has(id))) fail('unknown/missing surfaces');
    if (!list(item.platformCells) || item.platformCells.some((id) => !context.platforms.has(id))) fail('unknown/missing platform cells');
    if (!Array.isArray(item.oracleFiles) || !item.oracleFiles.length) fail('missing oracle sources');
    else {
      const paths = new Set();
      for (const file of item.oracleFiles) {
        if (!closed(file, ['path', 'sha256']) || !/^[a-f0-9]{64}$/.test(file.sha256)
          || context.files.get(file.path) !== file.sha256 || paths.has(file.path)) fail('stale/invalid oracle binding');
        paths.add(file?.path);
      }
    }
    const applicability = item.applicability;
    if (applicability?.status === 'required') {
      if (!closed(applicability, ['status'])) fail('invalid required applicability');
      if (!list(item.expectedArtifacts)) fail('missing expected artifacts');
      if (!Array.isArray(item.testBindings) || !item.testBindings.length) fail('missing test bindings');
      else {
        const identities = new Set();
        for (const binding of item.testBindings) {
          if (!closed(binding, ['suiteId', 'file', 'testId', 'command', 'timeoutMs', 'maxOutputBytes'])) {
            fail('invalid test binding fields'); continue;
          }
          const identity = `${binding.suiteId}:${binding.file}:${binding.testId}`;
          if (identities.has(identity)) fail('duplicate test binding');
          identities.add(identity);
          if (!context.suites.get(binding.suiteId)?.has(binding.file) || !nonempty(binding.testId)) fail('unregistered test binding');
          if (!context.testIds.get(binding.file)?.has(binding.testId)) fail('undeclared test identity');
          // Current adapter supports literal node:test declarations only. Broader
          // runners need their own reviewed adapter before being used as evidence.
          if (JSON.stringify(binding.command) !== JSON.stringify(['node', '--test', binding.file])) fail('unbound command argv');
          if (!Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs <= 0
            || !Number.isSafeInteger(binding.maxOutputBytes) || binding.maxOutputBytes <= 0) fail('missing command bounds');
        }
      }
    } else if (applicability?.status === 'inapplicable') {
      if (!closed(applicability, ['status', 'rationale', 'reviewer', 'sourcePaths'])
        || !nonempty(applicability.rationale) || !nonempty(applicability.reviewer)
        || !list(applicability.sourcePaths)
        || !Array.isArray(item.oracleFiles)
        || applicability.sourcePaths.some((path) => !item.oracleFiles.some((file) => file?.path === path))) {
        fail('unreviewed inapplicability');
      }
      if (!Array.isArray(item.testBindings) || item.testBindings.length
        || !Array.isArray(item.expectedArtifacts) || item.expectedArtifacts.length) fail('inapplicable requirement carries execution claims');
    } else fail('unknown applicability');
  }
  return errors;
}

export function missingRequirementCoverage(surfaceIds, requirements) {
  const cells = new Set((Array.isArray(requirements) ? requirements : []).flatMap((item) =>
    Array.isArray(item?.surfaceIds) && CATEGORIES.has(item.category)
      ? item.surfaceIds.map((id) => `${id}:${item.category}`) : []));
  return [...surfaceIds].flatMap((id) => [...CATEGORIES]
    .filter((category) => !cells.has(`${id}:${category}`)).map((category) => `${id}:${category}`));
}
