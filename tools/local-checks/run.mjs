import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeSuites } from '../test-runner/execute.mjs';
import { loadMatrix, suiteFiles, validateMatrix } from '../test-runner/matrix.mjs';
import { trackedPaths } from '../test-runner/git.mjs';
import { cleanEnvironment, git, withSnapshot } from './git.mjs';
import { selectLocalPlan } from './policy.mjs';
import { runLocalCommand } from './process.mjs';
import { discoverConsumerGraph } from './consumer-graph.mjs';
import { evaluateFocusedClosure } from './focused-closure.mjs';

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
  // All inherited child-visible variables are conservatively bound without disclosure.
  const inherited = Object.entries(cleanEnvironment()).sort(([a], [b]) => a.localeCompare(b));
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const version = spawnSync(python, ['--version'], { env: cleanEnvironment(), encoding: 'utf8', timeout: 3000 });
  if (version.error || version.status !== 0) throw new Error('Required local Python interpreter unavailable.');
  return { node: process.version, python: version.stdout.trim(), platform: process.platform,
    arch: process.arch, inheritedEnvironmentHash: hash(JSON.stringify(inherited)), policy: await policyFingerprint(),
    lock: hash(await readFile(join(root, 'package-lock.json'))),
    installedLock: hash(await readFile(join(root, 'node_modules/.package-lock.json'))) };
}

export async function runTarget(root, target, { mode, paths }) {
  return withSnapshot(root, target.commit, async (snapshot) => {
    const matrix = await loadMatrix(snapshot);
    const tracked = await trackedPaths(snapshot);
    const errors = validateMatrix(matrix, tracked);
    if (errors.length) throw new Error(errors.join('\n'));
    const graph = await discoverConsumerGraph(snapshot, tracked);
    const closure = evaluateFocusedClosure(graph, paths);
    const plan = selectLocalPlan(matrix, tracked, paths, { tag: target.tag, closure, mode });
    for (const suite of plan.native) {
      for (const path of suite.include) {
        let metadata;
        try { metadata = await lstat(join(snapshot, path)); } catch { /* Missing fails below. */ }
        if (!tracked.includes(path) || !metadata?.isFile() || metadata.isSymbolicLink()
          || !suiteFiles(suite, tracked).includes(path)) {
          throw new Error(`Mandatory native root unavailable: ${path}`);
        }
      }
    }

    const portable = [...plan.light, ...plan.heavy].filter((suite) => {
      if (suite.kind === 'command' || suiteFiles(suite, tracked).length) return true;
      const original = suiteFiles({ ...suite, exclude: (suite.exclude ?? []).filter((path) => !closure.nativeTests.includes(path)) }, tracked);
      return !original.length || !original.every((path) => closure.nativeTests.includes(path));
    });
    for (const suite of [...portable, ...plan.native]) {
      if (suite.kind !== 'command' && suiteFiles(suite, tracked).length === 0) {
        throw new Error(`Selected suite ${suite.id} has no tests; update local coverage rules.`);
      }
    }
    const identity = { commit: target.commit, tree: git(root, ['rev-parse', `${target.commit}^{tree}`]).trim(),
      base: target.base, tag: Boolean(target.tag), environment: await environmentIdentity(root),
      matrix: hash(JSON.stringify(matrix)), graph: graph.fingerprint, closure: closure.fingerprint,
      suites: [...portable, ...plan.native] };
    const key = hash(JSON.stringify(identity));
    const receipts = resolve(root, git(root, ['rev-parse', '--git-path', 'local-checks']).trim());
    await mkdir(receipts, { recursive: true });
    const receiptPath = join(receipts, `${key}.json`);
    let reused;
    if (mode === 'push' && plan.heavy.length) {
      let prior;
      try { prior = JSON.parse(await readFile(receiptPath, 'utf8')); } catch { /* No usable receipt. */ }
      if (reusableReceipt(prior, key)) {
        console.log(`Reusing portable local validation for ${target.commit.slice(0, 12)}; native obligations run freshly.`);
        if (!plan.native.length) return prior;
        reused = prior;
      } else throw new Error(`Broader validation required (${plan.heavy.map((s) => s.id).join(', ')}).\n`
        + `Run: npm run verify:deep -- --head ${target.commit} --base ${target.base}${target.tag ? ' --release' : ''}\n`
        + 'This hook did not start browser/package suites. No passing receipt is inferred.');
    }
    const selected = reused ? plan.native : [...portable.filter((suite) => mode === 'deep'
      || plan.light.some((light) => light.id === suite.id)), ...plan.native];
    const suites = selected.map((suite) => ({
      ...suite,
      ...(suite.id === 'source-size' ? { command: ['npm', 'run', 'check:size', '--', '--base', target.base] } : {}),
      timeoutMs: mode === 'deep' ? (suite.timeoutMs ?? 900_000) : 120_000,
    }));
    const startedAt = Date.now();
    let log = '';
    const output = (line) => { log += line; process.stdout.write(line); };
    const freshResults = await executeSuites(snapshot, suites, tracked, {
      concurrency: mode === 'deep' || reused ? 1 : 2, stdout: output, stderr: output, run: runLocalCommand,
    });
    const results = reused ? [...reused.results.filter((result) => !plan.native.some((suite) => suite.id === result.id)), ...freshResults] : freshResults;
    const passed = successfulLocalResults(freshResults, suites)
      && (!reused || successfulLocalResults(results, identity.suites));
    const completedAt = Date.now();
    const receipt = { schemaVersion: 1, key, ...identity, mode: reused ? 'deep' : mode, startedAt, completedAt,
      expiresAt: reused ? reused.expiresAt : completedAt + 24 * 60 * 60 * 1000, status: passed ? 'passed-local' : 'failed',
      results, ...(reused ? { reusedPortableReceiptCompletedAt: reused.completedAt } : {}), logHash: hash(log), deferredPlatforms: suites.filter((s) => s.platforms
        && !s.platforms.includes(process.platform)).map((s) => s.id) };
    await writeFile(join(receipts, `${key}.log`), log, { mode: 0o600 });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    if (!passed) throw new Error(`Local ${mode} validation failed; receipt retained at ${receiptPath}`);
    console.log(`Local ${mode} checks passed; ${results.length} suites. Receipts: ${receipts}`);
    return receipt;
  }, { dependencies: true });
}
