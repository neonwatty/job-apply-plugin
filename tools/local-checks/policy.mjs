import { matches } from '../test-runner/patterns.mjs';
import { selectAffected } from '../test-runner/matrix.mjs';

// Exact inert seams only. New production modules must not inherit a numeric-only test rule.
const FOCUSED = [
  {
    id: 'local-numeric',
    paths: ['src/contracts/raw-json/numeric-atom.ts', 'src/contracts/raw-json/float-scope.ts',
      'runtime/contracts/raw-json/numeric-atom.js', 'runtime/contracts/raw-json/float-scope.js',
      'tools/contracts/raw-json-numeric/**', 'tests_js/raw_json_numeric*.test.mjs'],
    tests: ['tests_js/raw_json_numeric*.test.mjs'],
  },
  {
    id: 'local-raw-reference',
    paths: ['tools/contracts/answer-matching-raw/**', 'tests_js/python-answer-matching-raw.test.mjs',
      'contracts/cli/python-answer-matching-raw.schema.json',
      'test/contract/vectors/python-answer-matching-raw-v1.json'],
    tests: ['tests_js/python-answer-matching-raw.test.mjs'],
  },
  {
    id: 'local-profile-reference',
    paths: ['tools/contracts/profile-facts/**', 'tests_js/python-profile-fact-contracts.test.mjs',
      'contracts/cli/python-profile-fact-mutations.schema.json',
      'test/contract/vectors/python-profile-fact-mutations-v1.json'],
    tests: ['tests_js/python-profile-fact-contracts.test.mjs'],
  },
];

export function selectLocalPlan(matrix, tracked, paths, { tag = false } = {}) {
  const fast = matrix.suites.filter((suite) => suite.tiers.includes('fast'));
  const light = new Map(fast.map((suite) => [suite.id, suite]));
  light.set('local-build', { id: 'local-build', kind: 'command', command: ['npm', 'run', 'build:check'] });
  light.set('local-links', { id: 'local-links', kind: 'command', command: ['node', 'tools/local-checks/links.mjs'] });
  const remaining = [];
  for (const path of paths) {
    if (matches(path, ['docs/**', 'README.md', 'LICENSE'])) continue;
    const rule = FOCUSED.find((rule) => matches(path, rule.paths));
    if (rule && tracked.includes(path)) {
      light.set(rule.id, { id: rule.id, kind: 'node-test', include: rule.tests });
    } else remaining.push(path);
  }
  const heavy = new Map();
  if (remaining.length || tag) {
    const selection = selectAffected(matrix, tracked, remaining);
    for (const suite of matrix.suites) {
      if (selection.suiteIds.includes(suite.id) && !light.has(suite.id)) heavy.set(suite.id, suite);
      // Global/unknown fallback must not omit release-only and native checks.
      if ((selection.fallbackReason || tag) && suite.tiers.some((tier) => ['release', 'platform'].includes(tier))) {
        heavy.set(suite.id, suite);
      }
      if (tag && suite.tiers.includes('full') && !light.has(suite.id)) heavy.set(suite.id, suite);
    }
  }
  return { light: [...light.values()], heavy: [...heavy.values()] };
}
