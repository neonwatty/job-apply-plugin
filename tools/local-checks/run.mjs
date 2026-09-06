import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeSuites } from '../test-runner/execute.mjs';
import { loadMatrix, suiteFiles, validateMatrix } from '../test-runner/matrix.mjs';
import { trackedPaths } from '../test-runner/git.mjs';
import { cleanEnvironment, git, withSnapshot } from './git.mjs';
import { selectLocalPlan } from './policy.mjs';
import { runLocalCommand } from './process.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const HERE = fileURLToPath(new URL('.', import.meta.url));

export async function policyFingerprint(directory = HERE) {
  const files = [];
  for (const folder of [directory, resolve(directory, '../test-runner')]) {
    for (const name of (await readdir(folder)).filter((name) => name.endsWith('.mjs')).sort()) {
      files.push(name, await readFile(join(folder, name)));
    }
  }
  return hash(Buffer.concat(files.map((value) => Buffer.from(value))));
}

export function successfulLocalResults(results, suites, platform = process.platform) {
  return results.length === suites.length && suites.every((suite) => {
    const result = results.find((item) => item.id === suite.id);
    return suite.platforms && !suite.platforms.includes(platform)
      ? result?.status === 'skipped' : result?.status === 'passed';
  });
}

export function reusableReceipt(receipt, key, now = Date.now()) {
  return receipt?.schemaVersion === 1 && receipt.key === key && receipt.status === 'passed-local'
    && receipt.mode === 'deep' && Array.isArray(receipt.results) && Array.isArray(receipt.suites)
    && successfulLocalResults(receipt.results, receipt.suites)
    && receipt.completedAt <= now && receipt.expiresAt > now;
}

async function environmentIdentity(root) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const version = spawnSync(python, ['--version'], { env: cleanEnvironment(), encoding: 'utf8', timeout: 3000 });
  if (version.error || version.status !== 0) throw new Error('Required local Python interpreter unavailable.');
  return { node: process.version, python: version.stdout.trim(), platform: process.platform,
    arch: process.arch, policy: await policyFingerprint(),
    lock: hash(await readFile(join(root, 'package-lock.json'))),
    installedLock: hash(await readFile(join(root, 'node_modules/.package-lock.json'))) };
}

export async function runTarget(root, target, { mode, paths }) {
  return withSnapshot(root, target.commit, async (snapshot) => {
    const matrix = await loadMatrix(snapshot);
    const tracked = await trackedPaths(snapshot);
    const errors = validateMatrix(matrix, tracked);
    if (errors.length) throw new Error(errors.join('\n'));
    const plan = selectLocalPlan(matrix, tracked, mode === 'commit' ? [] : paths, { tag: target.tag });
    for (const suite of [...plan.light, ...plan.heavy]) {
      if (suite.kind !== 'command' && suiteFiles(suite, tracked).length === 0) {
        throw new Error(`Selected suite ${suite.id} has no tests; update local coverage rules.`);
      }
    }
    const identity = { commit: target.commit, tree: git(root, ['rev-parse', `${target.commit}^{tree}`]).trim(),
      base: target.base, tag: Boolean(target.tag), environment: await environmentIdentity(root),
      matrix: hash(JSON.stringify(matrix)), suites: [...plan.light, ...plan.heavy] };
    const key = hash(JSON.stringify(identity));
    const receipts = resolve(root, git(root, ['rev-parse', '--git-path', 'local-checks']).trim());
    await mkdir(receipts, { recursive: true });
    const receiptPath = join(receipts, `${key}.json`);
    if (mode === 'push' && plan.heavy.length) {
      let prior;
      try { prior = JSON.parse(await readFile(receiptPath, 'utf8')); } catch { /* No usable receipt. */ }
      if (reusableReceipt(prior, key)) {
        console.log(`Reusing complete local validation for ${target.commit.slice(0, 12)}; deferred platform cells remain in receipt.`);
        return prior;
      }
      throw new Error(`Broader validation required (${plan.heavy.map((s) => s.id).join(', ')}).\n`
        + `Run: npm run verify:deep -- --head ${target.commit} --base ${target.base}${target.tag ? ' --release' : ''}\n`
        + 'This hook did not start browser/package suites. No passing receipt is inferred.');
    }
    const suites = [...plan.light, ...(mode === 'deep' ? plan.heavy : [])].map((suite) => ({
      ...suite,
      ...(suite.id === 'source-size' ? { command: ['npm', 'run', 'check:size', '--', '--base', target.base] } : {}),
      timeoutMs: mode === 'deep' ? (suite.timeoutMs ?? 900_000) : 120_000,
    }));
    const startedAt = Date.now();
    let log = '';
    const output = (line) => { log += line; process.stdout.write(line); };
    const results = await executeSuites(snapshot, suites, tracked, {
      concurrency: mode === 'deep' ? 1 : 2, stdout: output, stderr: output, run: runLocalCommand,
    });
    const passed = successfulLocalResults(results, suites);
    const completedAt = Date.now();
    const receipt = { schemaVersion: 1, key, ...identity, mode, startedAt, completedAt,
      expiresAt: completedAt + 24 * 60 * 60 * 1000, status: passed ? 'passed-local' : 'failed',
      results, logHash: hash(log), deferredPlatforms: suites.filter((s) => s.platforms
        && !s.platforms.includes(process.platform)).map((s) => s.id) };
    await writeFile(join(receipts, `${key}.log`), log, { mode: 0o600 });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    if (!passed) throw new Error(`Local ${mode} validation failed; receipt retained at ${receiptPath}`);
    console.log(`Local ${mode} checks passed; ${results.length} suites. Receipts: ${receipts}`);
    return receipt;
  }, { dependencies: true });
}
