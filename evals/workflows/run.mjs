#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { scenarioIds, runScenario } from './scenarios.mjs';
import { grade } from './grade.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let scenarios = scenarioIds;
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] !== '--scenario' || !scenarioIds.includes(process.argv[index + 1])) throw Error('Usage: run.mjs [--scenario SCENARIO]');
  scenarios = [process.argv[++index]];
}
const output = join(repository, '.workflows/local/installed-acceptance', String(Date.now()));
await mkdir(output, { recursive: true, mode: 0o700 });
const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
const report = { schemaVersion: 1, revision: git(['rev-parse', 'HEAD']),
  dirty: Boolean(git(['status', '--porcelain'])), evidenceKind: 'deterministic_installed_commands',
  runs: [], complete: false };
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
try {
  for (const scenario of scenarios) {
    const receipt = await runScenario(scenario);
    report.runs.push({ receipt, grade: grade(receipt) });
    await save();
  }
  report.complete = report.runs.every(run => run.grade.completion);
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'Scenario failed';
  throw error;
} finally {
  await save();
  console.log(`Installed command evidence: ${output}`);
}
if (!report.complete) process.exitCode = 1;
