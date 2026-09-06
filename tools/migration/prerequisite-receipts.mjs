import { createHash } from 'node:crypto';

// This accepts narrowly scoped prerequisites, never release or live activation.
// All filesystem/log/revision evidence is supplied by the trusted caller; no IO.
const FIELDS = ['id', 'kind', 'base', 'head', 'files', 'requirements', 'environment',
  'command', 'result', 'log', 'review', 'status'];
const closed = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const path = (value) => text(value) && !value.startsWith('/') && !/[\\:\x00-\x1f\x7f]/.test(value)
  && !value.split('/').some((part) => ['', '.', '..', '.git'].includes(part));
const strings = (value) => Array.isArray(value) && value.length > 0
  && value.every(text) && new Set(value).size === value.length;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) => createHash('sha256').update(value).digest('hex');

// Supported profile: Node TAP13, direct top-level tests, one terminal summary.
// Other reporter formats and nested suites require a reviewed adapter.
function tapCounts(log) {
  if (typeof log !== 'string' || !log.startsWith('TAP version 13\n')) return null;
  const summaries = [...log.matchAll(/^# tests (\d+)$/gm)];
  if (summaries.length !== 1) return null;
  const summary = log.slice(summaries[0].index);
  const match = /^# tests (\d+)\n# suites (\d+)\n# pass (\d+)\n# fail (\d+)\n# cancelled (\d+)\n# skipped (\d+)\n# todo (\d+)\n# duration_ms ([\d.]+)\n?$/.exec(summary);
  if (!match || !Number.isFinite(Number(match[8]))) return null;
  const [tests, suites, passed, failures, cancelled, skips, todo] = match.slice(1, 8).map(Number);
  if (![tests, suites, passed, failures, cancelled, skips, todo].every(count)) return null;
  if (suites !== 0 || todo !== 0 || /^not ok |^Bail out!/m.test(log)) return null;
  const results = [...log.matchAll(/^ok (\d+) - .+$/gm)];
  if (results.length !== tests || results.some((item, index) => Number(item[1]) !== index + 1)) return null;
  if (results.some((item) => /\s#\s*(?:SKIP|TODO)\b/i.test(item[0]))) return null;
  const plans = [...log.matchAll(/^1\.\.(\d+)$/gm)];
  if (plans.length !== 1 || Number(plans[0][1]) !== tests) return null;
  if (passed + failures + cancelled + skips !== tests) return null;
  return { tests, passed, failures, cancelled, skips };
}

export function validatePrerequisiteReceipts(receipts, context) {
  const errors = [];
  const acceptedReferences = new Set();
  const acceptedInterfaces = new Set();
  const result = () => ({ errors, acceptedReferences, acceptedInterfaces });
  if (!Array.isArray(receipts)) {
    errors.push('Prerequisite receipts must be an array');
    return result();
  }
  for (const key of ['files', 'revisionFiles', 'expectedCommands', 'logs',
    'expectedEnvironmentDetails', 'contracts']) {
    if (!(context?.[key] instanceof Map)) errors.push(`Missing receipt registry ${key}`);
  }
  for (const key of ['knownRevisions', 'knownRequirements', 'expectedEnvironments', 'ancestryPairs']) {
    if (!(context?.[key] instanceof Set)) errors.push(`Missing receipt registry ${key}`);
  }
  if (errors.length) return result();
  const seen = new Set();
  for (const receipt of receipts) {
    const before = errors.length;
    if (!closed(receipt, FIELDS)) {
      errors.push('Invalid prerequisite receipt fields');
      continue;
    }
    const label = text(receipt.id) ? receipt.id : '<invalid prerequisite>';
    const fail = (message) => errors.push(`${label}: ${message}`);
    if (!text(receipt.id) || seen.has(receipt.id)) fail('invalid/duplicate prerequisite ID');
    seen.add(receipt.id);
    if (!['reference', 'interface'].includes(receipt.kind)) fail('unsupported prerequisite kind');
    if (receipt.status !== 'passed') fail('unsupported prerequisite status');
    const contract = context.contracts.get(receipt.id);
    if (!closed(contract, ['kind', 'requirements', 'filePaths', 'command', 'environmentId', 'author', 'reviewer'])
      || !strings(contract.requirements) || !strings(contract.filePaths)) {
      fail('missing/invalid prerequisite contract');
    } else {
      const sameSet = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
        && new Set(actual).size === actual.length && actual.every((item) => expected.includes(item));
      if (receipt.kind !== contract.kind || !sameSet(receipt.requirements, contract.requirements)
        || !sameSet(Array.isArray(receipt.files) ? receipt.files.map((file) => file?.path) : null, contract.filePaths)
        || JSON.stringify(receipt.command) !== JSON.stringify(contract.command)
        || receipt.environment?.id !== contract.environmentId
        || receipt.review?.author !== contract.author || receipt.review?.reviewer !== contract.reviewer) {
        fail('receipt scope differs from prerequisite contract');
      }
    }
    for (const key of ['base', 'head']) {
      if (!sha(receipt[key]) || !context.knownRevisions.has(receipt[key])) fail(`unknown immutable ${key}`);
    }
    if (!sha(receipt.base) || !sha(receipt.head)
      || !context.ancestryPairs.has(`${receipt.base}:${receipt.head}`)) fail('unverified base ancestry');
    const revision = context.revisionFiles.get(receipt.head);
    if (!(revision instanceof Map)) fail('missing immutable file inventory');
    if (!Array.isArray(receipt.files) || !receipt.files.length) fail('missing prerequisite files');
    else {
      const paths = new Set();
      for (const file of receipt.files) {
        if (!closed(file, ['path', 'sha256']) || !path(file.path) || !hash(file.sha256)) {
          fail('invalid file binding');
          continue;
        }
        if (paths.has(file.path) || !context.files.has(file.path)
          || context.files.get(file.path) !== file.sha256
          || !(revision instanceof Map) || revision.get(file.path) !== file.sha256) fail('stale/unbound prerequisite file');
        paths.add(file.path);
      }
    }
    if (!strings(receipt.requirements)) fail('missing/duplicate requirement IDs');
    else for (const id of receipt.requirements) {
      if (!context.knownRequirements.has(id)) fail('unknown requirement');
      const commands = context.expectedCommands.get(id);
      if (!Array.isArray(commands) || !commands.some((argv) => Array.isArray(argv)
        && JSON.stringify(argv) === JSON.stringify(receipt.command))) fail('command does not satisfy requirement');
    }
    if (!Array.isArray(receipt.command) || !receipt.command.length || !receipt.command.every(text)) fail('invalid command argv');
    const environment = receipt.environment;
    if (!closed(environment, ['id', 'platform', 'node', 'unicode'])
      || !context.expectedEnvironments.has(environment.id)
      || !['darwin', 'linux', 'win32'].includes(environment.platform)
      || !text(environment.node) || !text(environment.unicode)
      || !/^v?\d+\.\d+\.\d+$/.test(environment.node)
      || !/^\d+(?:\.\d+){1,2}$/.test(environment.unicode)) fail('unknown/invalid environment');
    const expectedEnvironment = context.expectedEnvironmentDetails.get(environment?.id);
    if (!closed(expectedEnvironment, ['id', 'platform', 'node', 'unicode'])
      || ['id', 'platform', 'node', 'unicode'].some((key) => expectedEnvironment[key] !== environment?.[key])) {
      fail('environment differs from verified profile');
    }
    if (!closed(receipt.review, ['author', 'reviewer', 'decision'])
      || !text(receipt.review.author) || !text(receipt.review.reviewer)
      || receipt.review.author.trim() === receipt.review.reviewer.trim()
      || receipt.review.decision !== 'approved') fail('missing independent approval');
    const reported = receipt.result;
    const validResult = closed(reported, ['exitCode', 'tests', 'failures', 'skips', 'cancelled'])
      && Object.values(reported).every(count);
    if (!validResult || reported.exitCode !== 0 || reported.tests === 0
      || reported.failures !== 0 || reported.skips !== 0 || reported.cancelled !== 0) fail('unsuccessful/empty/skipped execution');
    const binding = receipt.log;
    if (!closed(binding, ['path', 'sha256']) || !path(binding.path) || !hash(binding.sha256)) fail('invalid log binding');
    else {
      const log = context.logs.get(binding.path);
      if (typeof log !== 'string' || digest(log) !== binding.sha256
        || context.files.get(binding.path) !== binding.sha256
        || !(revision instanceof Map) || revision.get(binding.path) !== binding.sha256) fail('missing/stale captured log');
      const observed = tapCounts(log);
      if (!observed || !validResult || ['tests', 'failures', 'skips', 'cancelled']
        .some((key) => observed[key] !== reported[key])) fail('unsupported/mismatched TAP evidence');
    }
    if (errors.length === before) {
      (receipt.kind === 'reference' ? acceptedReferences : acceptedInterfaces).add(receipt.id);
    }
  }
  // Invalid batches cannot partially unlock dependent work, including duplicate IDs.
  if (errors.length) {
    acceptedReferences.clear();
    acceptedInterfaces.clear();
  }
  return result();
}
