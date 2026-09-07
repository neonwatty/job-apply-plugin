import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

const REVIEWED_GRAPH_SUBJECT = 'b5407e8688e6486eacf6ab428b93c83ee809c385';
const GRAPH_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ANALYZER_FILES = ['consumer-graph.mjs', 'graph-syntax.mjs', 'focused-contracts.mjs', 'focused-closure.mjs']
  .map(name => `tools/local-checks/${name}`);

// This proof requires the reviewed commit locally. Shallow clones must fetch its history explicitly.
function reviewedGraphFiles() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const read = (operation, input) => {
    assert.ok(['tree', 'blobs'].includes(operation));
    const args = ['--no-replace-objects', ...(operation === 'tree'
      ? ['ls-tree', '-rz', REVIEWED_GRAPH_SUBJECT] : ['cat-file', '--batch'])];
    try {
      return execFileSync('git', args, { cwd: GRAPH_ROOT, env, input, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
    } catch (cause) {
      throw new Error(`Reviewed graph baseline ${REVIEWED_GRAPH_SUBJECT} unavailable; provide its Git history locally (no automatic fetch).`, { cause });
    }
  };
  const entries = read('tree').toString('utf8').split('\0').filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(row);
    assert.ok(match, `Unsupported baseline tree entry: ${row}`);
    const [, , oid, file] = match;
    assert.ok(!path.isAbsolute(file) && !file.split('/').some(part => !part || part === '.' || part === '..'));
    return { oid, file };
  });
  assert.ok(entries.length > 0 && entries.length <= 5000);
  assert.equal(new Set(entries.map(entry => entry.file)).size, entries.length);
  const blobs = read('blobs', entries.map(entry => entry.oid).join('\n') + '\n');
  const files = new Map();
  let offset = 0;
  for (const { oid, file } of entries) {
    const end = blobs.indexOf(10, offset);
    assert.ok(end >= offset);
    const header = blobs.subarray(offset, end).toString('ascii');
    const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    assert.ok(match && match[1] === oid, `Missing baseline blob: ${file}`);
    const size = Number(match[2]);
    assert.ok(Number.isSafeInteger(size) && size <= 8 * 1024 * 1024 && end + size + 1 < blobs.length);
    files.set(file, Buffer.from(blobs.subarray(end + 1, end + 1 + size)));
    offset = end + size + 2;
    assert.equal(blobs[offset - 1], 10);
  }
  assert.equal(offset, blobs.length);
  return files;
}

async function reviewedGraphFixture(t) {
  const { digest } = await import('../tools/local-checks/focused-contracts.mjs');
  const files = reviewedGraphFiles();
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reviewed-graph-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  // Only the implementation under test is overlaid; all caller/data/helper identities stay frozen.
  const overlayHashes = new Map();
  for (const file of ANALYZER_FILES) {
    const bytes = await fs.promises.readFile(path.join(GRAPH_ROOT, file));
    files.set(file, bytes);
    overlayHashes.set(file, digest(bytes));
  }
  for (const [file, bytes] of files) {
    await fs.promises.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.promises.writeFile(path.join(root, file), bytes);
  }
  for (const [file, hash] of overlayHashes) {
    assert.equal(digest(await fs.promises.readFile(path.join(root, file))), hash);
    assert.equal(digest(await fs.promises.readFile(path.join(GRAPH_ROOT, file))), hash);
  }
  return { root, files, paths: new Set(files.keys()) };
}

test('P03 graph follows runtime type support and literal child-process dependencies', async t => {
  const { createGraphFixture, GRAPH_SOURCE, GRAPH_RUNTIME, GRAPH_TEST, GRAPH_CHILD } = await import('./local_checks_graph_support.mjs');
  const { discoverConsumerGraph, reverseClosure } = await import('../tools/local-checks/consumer-graph.mjs');
  const { evaluateFocusedClosure } = await import('../tools/local-checks/focused-closure.mjs');
  const f = await createGraphFixture(t);
  let graph = await discoverConsumerGraph(f.root, f.tracked());
  assert.deepEqual(graph.reasons, []);
  assert.deepEqual(evaluateFocusedClosure(graph, [GRAPH_RUNTIME]).lightTests, [GRAPH_CHILD, GRAPH_TEST]);
  assert.ok(graph.edges.some(edge => edge.from === GRAPH_CHILD && edge.to === GRAPH_TEST && edge.kind === 'literal-child-process'));
  await f.write('src/type-consumer.ts', `import type { value } from './contracts/raw-json/float-scope.js';\nexport type Marker = typeof value;\n`);
  graph = await discoverConsumerGraph(f.root, f.tracked());
  assert.ok(reverseClosure(graph.edges, [GRAPH_SOURCE], { types: true }).includes('src/type-consumer.ts'));
  assert.ok(!reverseClosure(graph.edges, [GRAPH_SOURCE]).includes('src/type-consumer.ts'));
  await f.write('tests_js/aliased.test.mjs', `import { spawnSync as launch } from 'node:child_process';\nconst entry = 'tests_js/direct.test.mjs';\nlaunch(process.execPath, ['--test', entry]);\n`);
  graph = await discoverConsumerGraph(f.root, f.tracked());
  assert.ok(graph.edges.some(edge => edge.from === 'tests_js/aliased.test.mjs' && edge.to === GRAPH_TEST));
  assert.equal(evaluateFocusedClosure(graph, [GRAPH_RUNTIME]).bounded, false, 'unreviewed actual consumer must escalate');
});

test('P03 graph rejects unresolved relevant imports and missing owned targets', async t => {
  const { createGraphFixture, GRAPH_RUNTIME, GRAPH_SUPPORT } = await import('./local_checks_graph_support.mjs');
  const { discoverConsumerGraph } = await import('../tools/local-checks/consumer-graph.mjs');
  const { evaluateFocusedClosure } = await import('../tools/local-checks/focused-closure.mjs');
  const f = await createGraphFixture(t);
  const reviewed = reviewedGraphFiles();
  for (const file of ['migration_task_lineage_git_support.mjs', 'migration_task_lineage_lifecycle.test.mjs',
    'migration_task_replacements.test.mjs']) {
    await f.write(`tests_js/${file}`, reviewed.get(`tests_js/${file}`).toString('utf8'));
  }
  const fixtureSite = 'Unresolved execFileSync caller: tests_js/migration_task_lineage_git_support.mjs:2297';
  assert.ok(!(await discoverConsumerGraph(f.root, f.tracked())).reasons.includes(fixtureSite));
  await f.write('outside/new-fixture-consumer.mjs', "import {lineageRepository} from '../tests_js/migration_task_lineage_git_support.mjs'; export const escaped = lineageRepository;\n");
  assert.ok((await discoverConsumerGraph(f.root, f.tracked())).reasons.includes(fixtureSite));
  for (const source of [
    `export { value } from '../runtime/missing.js';`,
    `export const value = await import(process.env.MODULE);`,
    `import { spawnSync } from 'node:child_process'; const script = process.env.SCRIPT; spawnSync(process.execPath, [script]);`,
    `export { value } from 'unregistered-package';`,
    `import {spawnSync} from 'node:child_process'; process.execPath=process.env.EXECUTABLE; spawnSync(process.execPath, ['tests_js/direct.test.mjs']);`,
    `const URL = class {}; export const data=new URL('../docs/input.json', import.meta.url);`,
    `import {spawnSync} from 'node:child_process'; spawnSync(process.execPath, [process.env.ENTRY, '-e', 'process.exit(0)']);`,
    `import { spawnSync } from 'node:child_process'; let script = 'tests_js/direct.test.mjs'; script = process.env.SCRIPT; spawnSync(process.execPath, [script]);`,
    `import { spawnSync } from 'node:child_process'; spawnSync(process.execPath, [process.env.ENTRY, 'tests_js/direct.test.mjs']);`,
    `import { spawnSync } from 'node:child_process'; function f(spawnSync) { spawnSync(process.execPath, ['tests_js/direct.test.mjs']); }`,
  ]) {
    await f.write(GRAPH_SUPPORT, source);
    assert.equal(evaluateFocusedClosure(await discoverConsumerGraph(f.root, f.tracked()), [GRAPH_RUNTIME]).bounded, false);
  }

  const driver = 'tools/contracts/codepoint-json/reference.py';
  const driverCaller = 'tests_js/codepoint_json_reference.test.mjs';
  await f.write(driver, reviewed.get(driver).toString('utf8'));
  await f.write(driverCaller, reviewed.get(driverCaller).toString('utf8'));
  const beforeDriver = await discoverConsumerGraph(f.root, f.tracked());
  assert.ok(!beforeDriver.reasons.includes(`Unreviewed executable driver: ${driver}`));
  await f.write(driver, `${f.files.get(driver)}\nimport subprocess\nsubprocess.run(['node', 'new-consumer.mjs'])\n`);
  const afterDriver = await discoverConsumerGraph(f.root, f.tracked());
  assert.ok(afterDriver.reasons.includes(`Unreviewed executable driver: ${driver}`));
  const helper = 'tests_js/data_copy_support.mjs';
  const helperCaller = 'tests_js/data_copy_ts.test.mjs';
  for (const file of [helper, helperCaller]) {
    await f.write(file, reviewed.get(file).toString('utf8'));
  }
  const beforeHelper = await discoverConsumerGraph(f.root, f.tracked());
  assert.ok(!beforeHelper.reasons.includes(`Unreviewed process source helper: ${helper}`));
  await f.write(helper, `${f.files.get(helper)}\nexport const hiddenChild = 'node new-consumer.mjs';\n`);
  const afterHelper = await discoverConsumerGraph(f.root, f.tracked());
  assert.ok(afterHelper.reasons.includes(`Unreviewed process source helper: ${helper}`));
  const { PYTHON_SOURCE_PATH } = await import('../tools/local-checks/focused-contracts.mjs');
  for (const file of [...reviewed.keys()].filter(PYTHON_SOURCE_PATH)) {
    await f.write(file, reviewed.get(file).toString('utf8'));
  }
  const beforeInitialization = await discoverConsumerGraph(f.root, f.tracked());
  assert.ok(!beforeInitialization.reasons.includes('Unreviewed Python source inventory'));
  const initializer = 'scripts/job_apply_store/__init__.py';
  await f.write(initializer, `${f.files.get(initializer)}\nimport subprocess\nsubprocess.run(['node', 'hidden.mjs'])\n`);
  const afterInitialization = await discoverConsumerGraph(f.root, f.tracked());
  assert.ok(afterInitialization.reasons.includes('Unreviewed Python source inventory'));
  const { SKILL_SOURCE_PATH } = await import('../tools/local-checks/focused-contracts.mjs');
  for (const file of [...[...reviewed.keys()].filter(SKILL_SOURCE_PATH),
    'tests_js/workspace_skill_support.mjs', 'tests_js/workspace_answers.test.mjs', 'tests_js/workspace_markup.test.mjs']) {
    await f.write(file, reviewed.get(file).toString('utf8'));
  }
  assert.ok(!(await discoverConsumerGraph(f.root, f.tracked())).reasons.includes('Unreviewed skill document inventory'));
  await f.write('skills/job-apply/references/new-consumer.md', '[new source](../../../scripts/new-source.py)\n');
  assert.ok((await discoverConsumerGraph(f.root, f.tracked())).reasons.includes('Unreviewed skill document inventory'));
  for (const file of ['qa/unified_task_spine_oracle.mjs', 'tests_js/unified_task_spine_oracle.test.mjs', 'workspace/index.html']) {
    await f.write(file, reviewed.get(file).toString('utf8'));
  }
  const htmlReason = 'Unreviewed process source helper: workspace/index.html';
  assert.ok(!(await discoverConsumerGraph(f.root, f.tracked())).reasons.includes(htmlReason));
  await f.write('workspace/index.html', `${f.files.get('workspace/index.html')}\n<script src="hidden-consumer.js"></script>\n`);
  assert.ok((await discoverConsumerGraph(f.root, f.tracked())).reasons.includes(htmlReason));
  await f.write(GRAPH_SUPPORT, `export { value } from '../${GRAPH_RUNTIME}';`);
  await fs.promises.rm(path.join(f.root, GRAPH_RUNTIME));
  assert.equal(evaluateFocusedClosure(await discoverConsumerGraph(f.root, f.tracked()), []).bounded, false);
  await f.write(GRAPH_RUNTIME, 'export const value = 1;');
  await fs.promises.rm(path.join(f.root, 'README.md'));
  await fs.promises.symlink(path.join(f.root, GRAPH_RUNTIME), path.join(f.root, 'README.md'));
  const result = evaluateFocusedClosure(await discoverConsumerGraph(f.root, f.tracked()), ['README.md']);
  assert.equal(result.docsOnly, false); assert.equal(result.bounded, false);
});

test('P03 graph re-evaluates newly added consumers from the immutable subject', async t => {
  const { createGraphFixture, GRAPH_RUNTIME } = await import('./local_checks_graph_support.mjs');
  const { discoverConsumerGraph } = await import('../tools/local-checks/consumer-graph.mjs');
  const { evaluateFocusedClosure } = await import('../tools/local-checks/focused-closure.mjs');
  const { resolveDispatchCommand } = await import('../tools/local-checks/consumer-graph.mjs');
  const { inspectRunnerBindings, RUNNER_MODULES } = await import('../tools/local-checks/graph-syntax.mjs');
  const caller = 'tools/new-caller.mjs';
  const direct = inspectRunnerBindings(caller, "import {runCapture as capture} from './test-runner/process.mjs'; capture('node', args);", RUNNER_MODULES);
  assert.equal(direct.bindings[0].importedName, 'runCapture');
  assert.equal(direct.bindings[0].uses[0].kind, 'call');
  const escaped = inspectRunnerBindings(caller, "import {runCapture as capture} from './test-runner/process.mjs'; export const alias=capture;", RUNNER_MODULES);
  assert.equal(escaped.bindings[0].uses[0].kind, 'escape');
  assert.ok(inspectRunnerBindings(caller, "export {runCapture} from './test-runner/process.mjs';", RUNNER_MODULES).issues.length);
  assert.ok(inspectRunnerBindings(caller, "import * as runner from './test-runner/process.mjs';", RUNNER_MODULES).issues.length);
  const { projectDispatchers } = await import('../tools/local-checks/consumer-graph.mjs');
  const { digest } = await import('../tools/local-checks/focused-contracts.mjs');
  const baseline = await reviewedGraphFixture(t);
  const ROOT = baseline.root;
  const actualPaths = baseline.paths;
  const actualSources = new Map(await Promise.all([...actualPaths].filter(file => /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(file))
    .map(async file => [file, await fs.promises.readFile(path.join(ROOT, file), 'utf8')])));
  const actualHashes = new Map([...actualSources].map(([file, source]) => [file, digest(source)]));
  const observed = await projectDispatchers(ROOT, actualPaths, actualSources, actualHashes, []);
  assert.deepEqual(observed.reasons, [], 'reviewed actual dispatcher graph must be proven');
  const actualGraph = await discoverConsumerGraph(ROOT, actualPaths);
  assert.deepEqual(actualGraph.reasons, [], 'actual repository process and data routes must be closed');
  const liveGraph = await discoverConsumerGraph(GRAPH_ROOT, await trackedPaths(GRAPH_ROOT));
  const { PYTHON_SOURCE_PATH } = await import('../tools/local-checks/focused-contracts.mjs');
  const livePython = [...liveGraph.tracked].filter(PYTHON_SOURCE_PATH).sort();
  const frozenPython = [...baseline.paths].filter(PYTHON_SOURCE_PATH).sort();
  const pythonChanged = JSON.stringify(livePython) !== JSON.stringify(frozenPython)
    || livePython.some(file => liveGraph.hashes.get(file) !== digest(baseline.files.get(file)));
  if (pythonChanged) assert.ok(liveGraph.reasons.includes('Unreviewed Python source inventory'));
  const impactInput = file => ![...ANALYZER_FILES, 'tests_js/test-runner-selection.test.mjs'].includes(file);
  const liveInputs = [...liveGraph.tracked].filter(impactInput).sort();
  const reviewedInputs = [...baseline.paths].filter(impactInput).sort();
  let unchangedImpactInputs = JSON.stringify(liveInputs) === JSON.stringify(reviewedInputs);
  if (unchangedImpactInputs) {
    for (const file of liveInputs) {
      try {
        const target = path.join(GRAPH_ROOT, file);
        if (!(await fs.promises.lstat(target)).isFile()
          || digest(await fs.promises.readFile(target)) !== digest(baseline.files.get(file))) {
          unchangedImpactInputs = false;
          break;
        }
      } catch {
        unchangedImpactInputs = false;
        break;
      }
    }
  }
  if (unchangedImpactInputs) assert.deepEqual(liveGraph.reasons, [], 'unchanged reviewed inputs must remain focused');
  if (liveGraph.reasons.length) assert.equal(evaluateFocusedClosure(liveGraph, []).bounded, false);
  if (unchangedImpactInputs) assert.equal(evaluateFocusedClosure(liveGraph, []).bounded, true);
  await fs.promises.mkdir(path.join(ROOT, 'tools/contracts/future-reference'), { recursive: true });
  const addedDriver = 'tools/contracts/future-reference/reference.py';
  await fs.promises.writeFile(path.join(ROOT, addedDriver), 'print("new reference")\n');
  const grown = await discoverConsumerGraph(ROOT, new Set([...actualPaths, addedDriver]));
  assert.ok(grown.reasons.includes('Unreviewed Python source inventory'));
  assert.equal(evaluateFocusedClosure(grown, []).bounded, false);
  assert.notEqual(grown.fingerprint, actualGraph.fingerprint);
  await fs.promises.rm(path.join(ROOT, addedDriver));

  for (const rule of actualGraph.contract.rules) {
    for (const changed of [...rule.runtimePaths ?? [], ...rule.sharedContractPaths ?? [], ...rule.referencePaths ?? [], ...rule.testInputPaths ?? []]) {
      const selected = evaluateFocusedClosure(actualGraph, [changed]);
      assert.equal(selected.bounded, true, `${rule.id}: ${selected.reasons.join('; ')}`);
      assert.equal(selected.nativeTests.length, 6, 'six separately fresh native obligations remain selected');
    }
  }
  const inspectedSource = 'tests_js/raw_json_numeric.test.mjs', inspector = 'tests_js/migration_test_bindings.test.mjs';
  assert.ok(evaluateFocusedClosure(actualGraph, [inspectedSource]).lightTests.includes(inspector));
  const changedDriver = evaluateFocusedClosure(actualGraph, ['tools/contracts/raw-json-numeric/reference.py']);
  assert.ok(changedDriver.lightTests.includes(inspectedSource));
  assert.ok(!changedDriver.lightTests.includes(inspector), 'runtime invalidation does not alter inspected source bytes');
  const newNative = 'tests_js/new-native-consumer.test.mjs';
  const expandedNative = { ...actualGraph, tracked: new Set([...actualGraph.tracked, newNative]),
    nativeTests: [...actualGraph.nativeTests, newNative],
    edges: [...actualGraph.edges, { from: newNative, to: actualGraph.contract.rules[0].runtimePaths[0], kind: 'import' }] };
  assert.equal(evaluateFocusedClosure(expandedNative, []).bounded, false, 'an unexecuted new native root is not covered by the canonical six');
  for (const text of [
    "import {runCapture as launch} from './test-runner/process.mjs'; launch('node', ['hidden.mjs']);",
    "export {runCapture} from './test-runner/process.mjs';",
    "import * as unknown from './test-runner/process.mjs';",
  ]) {
    const changedSources = new Map(actualSources).set(caller, text);
    const changedHashes = new Map(actualHashes).set(caller, digest(text));
    const changed = await projectDispatchers(ROOT, new Set([...actualPaths, caller]), changedSources, changedHashes, []);
    assert.ok(changed.reasons.some(reason => reason.includes(caller)), 'new actual caller must invalidate even with no changed-path hint');
  }
  const scripts = { build: 'node tools/build-runtime.mjs --check' };
  assert.deepEqual(resolveDispatchCommand(['npm', 'run', 'build'], scripts).targets, ['tools/build-runtime.mjs']);
  for (const hook of ['prebuild', 'postbuild']) {
    assert.match(resolveDispatchCommand(['npm', 'run', 'build'], { ...scripts, [hook]: 'node new-consumer.mjs' }).error, /lifecycle/);
  }
  assert.ok(resolveDispatchCommand(['npm', 'run', 'build'], { build: 'node first.mjs && node hidden.mjs' }).error);
  const f = await createGraphFixture(t), original = await discoverConsumerGraph(f.root, f.tracked());
  assert.equal(evaluateFocusedClosure(original, []).bounded, true);
  assert.equal(evaluateFocusedClosure(original, []).docsOnly, false);
  assert.equal(evaluateFocusedClosure(original, ['README.md']).docsOnly, true);
  await f.write('outside-common-roots/consumer.test.mjs', `import { value } from '../${GRAPH_RUNTIME}';\nthrow Error('consumer mutation');\n`);
  const added = await discoverConsumerGraph(f.root, f.tracked());
  assert.notEqual(added.fingerprint, original.fingerprint);
  assert.equal(evaluateFocusedClosure(added, []).bounded, false, 'empty changes cannot hide a newly discovered consumer');
  assert.ok(evaluateFocusedClosure(added, []).reasons.some(reason => reason.includes('outside-common-roots/consumer.test.mjs')));
  await f.write('package-lock.json', '{"lockfileVersion":3,"changed":true}\n');
  assert.notEqual((await discoverConsumerGraph(f.root, f.tracked())).fingerprint, added.fingerprint);
});

test('P03 graph binds source and emitted module identities without duplicate consumers', async t => {
  const { createGraphFixture, GRAPH_SOURCE, GRAPH_RUNTIME, GRAPH_TEST, GRAPH_CHILD } = await import('./local_checks_graph_support.mjs');
  const { discoverConsumerGraph } = await import('../tools/local-checks/consumer-graph.mjs');
  const { evaluateFocusedClosure } = await import('../tools/local-checks/focused-closure.mjs');
  const f = await createGraphFixture(t), graph = await discoverConsumerGraph(f.root, f.tracked());
  assert.deepEqual(evaluateFocusedClosure(graph, [GRAPH_SOURCE]).lightTests, evaluateFocusedClosure(graph, [GRAPH_RUNTIME]).lightTests);
  assert.deepEqual(evaluateFocusedClosure(graph, [GRAPH_SOURCE, GRAPH_RUNTIME]).lightTests, [GRAPH_CHILD, GRAPH_TEST]);
  await f.write(GRAPH_SOURCE, 'export const value = 2;\n');
  const changed = await discoverConsumerGraph(f.root, f.tracked());
  assert.notEqual(changed.fingerprint, graph.fingerprint);
  assert.notEqual(changed.hashes.get(GRAPH_SOURCE), changed.hashes.get(GRAPH_RUNTIME));
  await f.write('docs/input.json', '{"value":1}\n');
  await f.write('tests_js/data.test.mjs', "export const input = new URL('../docs/input.json', import.meta.url);\n");
  const beforeData = await discoverConsumerGraph(f.root, f.tracked());
  await f.write('docs/input.json', '{"value":2}\n');
  const afterData = await discoverConsumerGraph(f.root, f.tracked());
  assert.notEqual(afterData.fingerprint, beforeData.fingerprint, 'non-code input bytes belong to graph identity');
  assert.equal(evaluateFocusedClosure(afterData, ['docs/input.json']).docsOnly, false);
  assert.ok(evaluateFocusedClosure(afterData, ['docs/input.json']).reasons.some(reason => reason.includes('test input')));
  await f.write('tools/local-checks/graph-syntax.mjs', '// different analyzer\n');
  assert.equal(evaluateFocusedClosure(await discoverConsumerGraph(f.root, f.tracked()), []).bounded, false);
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
