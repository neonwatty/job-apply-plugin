import { selectAffected } from '../test-runner/matrix.mjs';

export function selectLocalPlan(matrix, tracked, paths, { tag = false, closure, mode = 'push' } = {}) {
  const fast = matrix.suites.filter((suite) => suite.tiers.includes('fast'));
  const light = new Map(fast.map((suite) => [suite.id, suite]));
  light.set('local-build', { id: 'local-build', kind: 'command', command: ['npm', 'run', 'build:check'] });
  light.set('local-links', { id: 'local-links', kind: 'command', command: ['node', 'tools/local-checks/links.mjs'] });
  const heavy = new Map();
  const bounded = closure?.bounded === true;
  if (mode !== 'commit') {
    const focusedLight = bounded ? closure.lightTests.filter((path) => !closure.heavyTests.includes(path)) : [];
    if (focusedLight.length) {
      light.set('local-dependent-unit', { id: 'local-dependent-unit', kind: 'node-test', include: focusedLight });
    }
    if (bounded && closure.heavyTests.length) {
      heavy.set('local-dependent-integration', { id: 'local-dependent-integration', kind: 'node-test', include: closure.heavyTests });
    }
    const remaining = bounded ? closure.remainingPaths : paths;
    if (!bounded || remaining.length || tag) {
      const selection = selectAffected(matrix, tracked, remaining);
      for (const suite of matrix.suites) {
        if ((!bounded || selection.suiteIds.includes(suite.id)) && !light.has(suite.id)) heavy.set(suite.id, suite);
        if ((!bounded || selection.fallbackReason || tag) && suite.tiers.some((tier) => ['release', 'platform'].includes(tier))) {
          heavy.set(suite.id, suite);
        }
        if (tag && suite.tiers.includes('full') && !light.has(suite.id)) heavy.set(suite.id, suite);
      }
    }
  }
  const nativePaths = closure?.nativeTests ?? [];
  // Native obligations are a separate fresh run, never inferred from portable receipts.
  const native = mode === 'deep' || (mode === 'push' && heavy.size > 0)
    ? ['native-posix-lock', 'native-posix-timestamps'].map((id) => {
      const configured = matrix.suites.find((suite) => suite.id === id);
      const include = nativePaths.filter((path) => id === 'native-posix-timestamps'
        ? path.endsWith('/posix_timestamps.test.mjs') : !path.endsWith('/posix_timestamps.test.mjs'));
      return { ...configured, id, kind: 'node-test', include, platforms: configured?.platforms ?? ['darwin', 'linux'] };
    }).filter((suite) => suite.include.length) : [];
  for (const suites of [light, heavy]) {
    for (const [id, suite] of suites) {
      if (suite.kind !== 'node-test' || !nativePaths.length) continue;
      suites.set(id, { ...suite, exclude: [...new Set([...(suite.exclude ?? []), ...nativePaths])] });
    }
  }
  return { light: [...light.values()], heavy: [...heavy.values()], native,
    reasons: bounded ? closure.reasons : closure?.reasons ?? ['Consumer graph unavailable'] };
}
