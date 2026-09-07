const count = value => Number.isSafeInteger(value) && value >= 0;

// Supported profile: Node TAP13, direct top-level tests, one terminal summary.
// Other reporter formats and nested suites require a reviewed adapter.
export function tapCounts(log) {
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

// Task evidence additionally binds observed names and rejects nested reporters.
export function parseTaskTap(log) {
  const counts = tapCounts(log);
  if (!counts || counts.tests === 0 || counts.failures || counts.cancelled || counts.skips) return null;
  if (/^\s+(?:# Subtest:|(?:not )?ok \d+|1\.\.\d+)/m.test(log)) return null;
  const metrics = [...log.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /gm)].map(match => match[1]);
  if (JSON.stringify(metrics) !== JSON.stringify(['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'])) return null;
  const names = [...log.matchAll(/^ok \d+ - (.+)$/gm)].map(match => match[1]);
  const announcements = [...log.matchAll(/^# Subtest: (.+)$/gm)].map(match => match[1]);
  if (new Set(names).size !== names.length || names.some(name => name.includes('#'))
    || JSON.stringify(names) !== JSON.stringify(announcements)) return null;
  let yaml = false, pending = null, completed = 0, planned = false, summary = false;
  const lines = log.trimEnd().split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '  ---') { if (yaml || pending !== null || !completed || planned) return null; yaml = true; continue; }
    if (line === '  ...') { if (!yaml) return null; yaml = false; continue; }
    if (yaml) { if (!/^  [^\r\n]+$/.test(line)) return null; continue; }
    if (line.startsWith('# Subtest: ')) {
      if (pending !== null || planned) return null;
      pending = line.slice(11); continue;
    }
    const result = /^ok (\d+) - (.+)$/.exec(line);
    if (result) {
      if (planned || pending !== result[2] || Number(result[1]) !== completed + 1) return null;
      pending = null; completed += 1; continue;
    }
    if (/^1\.\.\d+$/.test(line)) {
      if (planned || pending !== null || completed !== counts.tests) return null;
      planned = true; continue;
    }
    if (line.startsWith('# tests ')) { if (!planned) return null; summary = true; }
    if (!/^# [^\r\n]*$/.test(line) || planned && !summary) return null;
  }
  const durationMs = Number(/\n# duration_ms ([\d.]+)\n?$/.exec(log)?.[1]);
  return yaml || pending !== null || !planned || !summary || !Number.isFinite(durationMs)
    ? null : { ...counts, names, durationMs };
}
