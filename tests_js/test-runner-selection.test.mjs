import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectChanges, parseNameStatus, trackedPaths } from "../tools/test-runner/git.mjs";
import { loadMatrix, selectAffected, validateMatrix } from "../tools/test-runner/matrix.mjs";

const matrix = {
  schemaVersion: 1,
  inventory: { include: ["tests/**", "src/**"] },
  fullInventory: { include: ["tests/*.test.mjs"] },
  globalPaths: ["config/**"],
  suites: [
    { id: "fast", kind: "node-test", include: ["tests/fast.test.mjs"], tiers: ["fast", "full"] },
    { id: "slow", kind: "node-test", include: ["tests/slow.test.mjs"], tiers: ["full"] },
  ],
  ownership: [
    { paths: ["src/fast/**"], suites: ["fast"] },
    { paths: ["src/shared/**"], suites: ["fast", "slow"] },
  ],
};
const tracked = ["tests/fast.test.mjs", "tests/slow.test.mjs", "src/fast/a.mjs", "src/shared/b.mjs"];

test("affected selection unions owners and selects a changed test itself", () => {
  assert.deepEqual(selectAffected(matrix, tracked, ["src/shared/b.mjs"]), {
    suiteIds: ["fast", "slow"], fallbackReason: null,
  });
  assert.deepEqual(selectAffected(matrix, tracked, ["tests/slow.test.mjs"]), {
    suiteIds: ["fast", "slow"], fallbackReason: null,
  });
});

test("global and unknown changes fail closed to the full tier", () => {
  assert.match(selectAffected(matrix, tracked, ["config/matrix.json"]).fallbackReason, /^global path:/);
  assert.match(selectAffected(matrix, tracked, ["private/new.kind"]).fallbackReason, /^unknown path:/);
  assert.deepEqual(selectAffected(matrix, tracked, ["private/new.kind"]).suiteIds, ["fast", "slow"]);
});

test("real shared Python helpers select every consuming shard", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [realMatrix, realPaths] = await Promise.all([loadMatrix(root), trackedPaths(root)]);
  for (const helper of ["store_case.py", "workspace_case.py", "compiler_case.py", "macos_workflow_contract.py"]) {
    const selected = selectAffected(realMatrix, realPaths, [`tests/support/${helper}`]);
    assert.equal(selected.fallbackReason, null);
    for (const id of [
      "python-fast", "python-qa", "python-workspace-contracts", "python-accounts",
      "python-core", "windows-contracts", "macos-native-contracts",
    ]) assert.equal(selected.suiteIds.includes(id), true, `${helper} omitted ${id}`);
  }
});

test("real production paths conservatively include cross-language consumers", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const [realMatrix, realPaths] = await Promise.all([loadMatrix(root), trackedPaths(root)]);
  const cases = new Map([
    ["scripts/qa-replay.py", ["python-qa", "python-workspace-contracts", "python-accounts", "python-core", "node-recorder", "node-renderer", "node-workspace-other"]],
    ["scripts/job_apply_store/domains/jobs/crud.py", ["python-workspace-contracts", "python-accounts", "python-core", "node-workspace-other"]],
    ["scripts/job_apply_workspace/server.py", ["python-workspace-contracts", "node-workspace-other"]],
    ["qa/renderer/server.py", ["python-qa", "node-recorder", "node-renderer", "node-workspace-other"]],
    ["workspace/server/routes.js", ["python-workspace-contracts", "node-workspace-other"]],
  ]);
  for (const [changed, expected] of cases) {
    const selected = selectAffected(realMatrix, realPaths, [changed]);
    assert.equal(selected.fallbackReason, null);
    for (const id of expected) assert.equal(selected.suiteIds.includes(id), true, `${changed} omitted ${id}`);
  }
});

test("matrix validation rejects omissions and duplicate full inventory", () => {
  assert.deepEqual(validateMatrix(matrix, tracked), []);
  const duplicate = structuredClone(matrix);
  duplicate.suites[1].include.push("tests/fast.test.mjs");
  assert.ok(validateMatrix(duplicate, tracked).some((error) => error.includes("count 2")));
  assert.ok(validateMatrix(matrix, [...tracked, "src/unowned/file.mjs"]).some(
    (error) => error.includes("unowned executable/test path"),
  ));
  const empty = structuredClone(matrix);
  empty.suites[0].include = ["tests/missing*.test.mjs"];
  assert.ok(validateMatrix(empty, tracked).some((error) => error.includes("match no tracked tests")));
});

test("name-status parsing preserves both rename paths and deletions", () => {
  const value = "R100\0old.py\0new.py\0D\0gone.py\0M\0kept.py\0";
  assert.deepEqual(parseNameStatus(value), ["old.py", "new.py", "gone.py", "kept.py"]);
});

test("git selection combines committed, staged, unstaged, deleted, renamed, and untracked paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-runner-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  try {
    git("init", "-q");
    git("config", "user.email", "tests@example.invalid");
    git("config", "user.name", "Test Runner");
    for (const name of ["committed.txt", "rename-old.py", "delete-me.py", "unstaged.py"]) {
      fs.writeFileSync(path.join(root, name), `${name}\n`);
    }
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    fs.appendFileSync(path.join(root, "committed.txt"), "changed\n");
    fs.rmSync(path.join(root, "delete-me.py"));
    git("add", "committed.txt", "delete-me.py");
    git("commit", "-qm", "committed changes");
    git("mv", "rename-old.py", "rename-new.py");
    fs.appendFileSync(path.join(root, "unstaged.py"), "unstaged\n");
    fs.writeFileSync(path.join(root, "untracked.py"), "untracked\n");
    const result = await collectChanges(root, base);
    assert.deepEqual(result.changedPaths, [
      "committed.txt", "delete-me.py", "rename-new.py", "rename-old.py",
      "unstaged.py", "untracked.py",
    ]);
    const runnable = await trackedPaths(root);
    assert.equal(runnable.includes("untracked.py"), true);
    assert.equal(runnable.includes("delete-me.py"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const GRAPH_ROOT = fileURLToPath(new URL('../', import.meta.url));
import { HELPER_PATH, workerToken, dispatchRequest, workerResult, fixtureEnvironment, checkLiveGraph } from './graph_environment_support.mjs';

const EXPECTED_GROUPS = {
  'runtime-dependencies': 'P03 graph follows runtime type support and literal child-process dependencies',
  'unresolved-inputs': 'P03 graph rejects unresolved relevant imports and missing owned targets',
  'immutable-consumers': 'P03 graph re-evaluates newly added consumers from the immutable subject',
  'source-emitted-identities': 'P03 graph binds source and emitted module identities without duplicate consumers',
  'inherited-context': 'P12 inherited override refusal',
};
function captureWorker(token, root, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER_PATH, '--p12-worker', token], {
      cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: [], stderr: [] };
    let bytes = 0, failure, forceFinish, settled = false;
    const timer = setTimeout(() => stop(new Error('Worker timed out after20000ms')), 20000);
    function finish(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceFinish);
      if (failure) reject(failure);
      else resolve({ status: code, signal, stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8') });
    }
    function stop(error) {
      if (failure || settled) return;
      failure = error;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch (cause) { if (cause.code !== 'ESRCH') failure = cause; }
      forceFinish = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); finish(null, 'SIGKILL');
      }, 1000);
    }
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > 65536) stop(new Error('Worker output exceeds65536bytes'));
      else output[stream].push(chunk);
    });
    child.on('error', error => { failure = error; finish(null, null); });
    child.on('close', finish);
  });
}

async function runGraphWorker(token) {
  const before = { ...process.env };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-environment-'));
  try {
    const env = fixtureEnvironment(root, process.env);
    fs.writeFileSync(env.npm_config_userconfig, '');
    fs.writeFileSync(env.npm_config_globalconfig, '');
    if (token === 'inherited-context') env.npm_config_prefix = '/p12-unproved-prefix';
    const result = await captureWorker(token, root, env);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(Object.hasOwn(EXPECTED_GROUPS, token));
    const expected = { schemaVersion: 1, token, status: 'passed', assertionGroup: EXPECTED_GROUPS[token], cleanupComplete: true,
      ...(token === 'inherited-context' ? { bounded: false, reason: 'Unproved runner environment override' } : {}) };
    assert.equal(result.stdout, JSON.stringify(expected) + '\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    assert.deepEqual({ ...process.env }, before);
  }
}

test('P03 graph follows runtime type support and literal child-process dependencies', async () => {
  await runGraphWorker('runtime-dependencies');
});

test('P03 graph rejects unresolved relevant imports and missing owned targets', async () => {
  await runGraphWorker('unresolved-inputs');
});

test('P03 graph re-evaluates newly added consumers from the immutable subject', async () => {
  await runGraphWorker('immutable-consumers');
  await checkLiveGraph();
});

test('P03 graph binds source and emitted module identities without duplicate consumers', async () => {
  await runGraphWorker('source-emitted-identities');
});

test('P10 reference suites isolate S04 and S05 without changing process output limits', async () => {
  const { assertReferenceSuiteIsolation } = await import('./reference_suite_support.mjs');
  const [actualMatrix, actualPaths] = await Promise.all([loadMatrix(GRAPH_ROOT), trackedPaths(GRAPH_ROOT)]);
  assertReferenceSuiteIsolation(actualMatrix, actualPaths);
});

test('P10 reference suite ownership preserves shared inputs and rejects missing or duplicate coverage', async () => {
  const { assertReferenceSuiteFanout } = await import('./reference_suite_support.mjs');
  const [actualMatrix, actualPaths] = await Promise.all([loadMatrix(GRAPH_ROOT), trackedPaths(GRAPH_ROOT)]);
  assertReferenceSuiteFanout(actualMatrix, actualPaths);
});

test('P12 immutable graph proof isolates fixture environment while inherited overrides fail closed', async () => {
  const before = { ...process.env };
  const root = path.join(os.tmpdir(), 'p12-protocol-only');
  const hostile = { PATH: process.env.PATH, NODE_OPTIONS: 'invalid', NODE_PATH: '/invalid', PYTHON: '/invalid',
    PYTHONHOME: '/invalid', PYTHONPATH: '/invalid', npm_config_prefix: '/invalid', NPM_CONFIG_PREFIX: '/invalid',
    npm_config_script_shell: '/invalid', NPM_CONFIG_SCRIPT_SHELL: '/invalid', npm_config_location: 'global',
    NPM_CONFIG_LOCATION: 'global', npm_config_userconfig: '/invalid', npm_config_globalconfig: '/invalid' };
  const env = fixtureEnvironment(root, hostile);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TEMP', 'TMP', 'TMPDIR',
    'npm_config_globalconfig', 'npm_config_userconfig'].sort());
  assert.equal(env.HOME, root);
  assert.equal(env.npm_config_userconfig, path.join(root, 'user.npmrc'));
  assert.equal(env.npm_config_globalconfig, path.join(root, 'global.npmrc'));
  assert.equal(workerToken([process.execPath, import.meta.filename]), null, 'import must be inert');
  for (const args of [[], ['--p12-worker'], ['--p12-worker', 'unknown'], ['--p12-worker', 'runtime-dependencies', 'extra']]) {
    assert.throws(() => workerToken([process.execPath, HELPER_PATH, ...args]));
    assert.deepEqual(dispatchRequest([process.execPath, HELPER_PATH, ...args]), { token: null, exitCode: 2 });
  }
  assert.throws(() => workerResult('unknown'));
  assert.deepEqual({ ...process.env }, before, 'rejected protocol never mutates parent');
  await runGraphWorker('inherited-context');
  assert.deepEqual({ ...process.env }, before);
});
