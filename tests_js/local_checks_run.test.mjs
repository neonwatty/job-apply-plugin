import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTarget as actualRunTarget } from "../tools/local-checks/run.mjs";
import { createGraphFixture, GRAPH_RUNTIME, GRAPH_SOURCE, GRAPH_TEST, GRAPH_CHILD } from "./local_checks_graph_support.mjs";

async function runTarget(...args) {
  const previous = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return await actualRunTarget(...args); }
  finally { if (previous !== undefined) process.env.NODE_TEST_CONTEXT = previous; }
}

function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = spawnSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8", env, timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function put(root, name, value) {
  const destination = path.join(root, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, value);
}

async function fixture(t, fail = false) {
  const graphFixture = await createGraphFixture(t);
  const root = graphFixture.root;
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Synthetic Local Checks"]);
  git(root, ["config", "user.email", "synthetic@example.invalid"]);
  const marker = path.join(root, ".git", "executions.txt");
  const record = `require('node:fs').appendFileSync(${JSON.stringify(marker)},'ran\\n');process.exitCode=${fail ? 5 : 0};`;
  const matrix = {
    schemaVersion: 1,
    inventory: { include: [] },
    fullInventory: { include: [] },
    globalPaths: ["src/**"],
    suites: [{ id: "synthetic-broad", kind: "command", command: [process.execPath, "-e", record], tiers: ["full"], timeoutMs: 1000 }],
    ownership: [],
  };
  await put(root, ".gitignore", "node_modules/\n/node_modules\n");
  await put(root, "config/test-matrix.json", JSON.stringify(matrix));
  await put(root, "package.json", JSON.stringify({ private: true, type: "module", devDependencies: { typescript: "5.9.3" }, scripts: { "build:check": "node -e \"process.exit(0)\"" } }));
  const lock = JSON.stringify({ name: "synthetic", lockfileVersion: 3, packages: {} });
  await put(root, "package-lock.json", lock);
  await put(root, "node_modules/.package-lock.json", lock);
  await put(root, "tools/local-checks/links.mjs", "// Synthetic no-op link validation.\n");
  const nativeFailure = path.join(root, ".git", "native-failure");
  await graphFixture.write("tests_js/posix_timestamps.test.mjs", [
    "import test from 'node:test'; import fs from 'node:fs';",
    `test('owned native substitute',()=>{if(fs.existsSync(${JSON.stringify(nativeFailure)}))throw Error('fresh native failed')});`,
  ].join("\n"));
  await put(root, "src/domain.ts", "// synthetic base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "synthetic base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  await put(root, "src/domain.ts", "// synthetic target\n");
  git(root, ["add", "src/domain.ts"]);
  git(root, ["commit", "-m", "synthetic target"]);
  return { root, marker, nativeFailure, graphFixture, target: { base, commit: git(root, ["rev-parse", "HEAD"]), tag: false } };
}

const changed = { paths: ["src/domain.ts"] };

test("push broad selection refuses before running commands and cleans its snapshot", async (t) => {
  const { root, marker, target } = await fixture(t);
  const before = git(root, ["worktree", "list", "--porcelain"]);
  await assert.rejects(runTarget(root, target, { mode: "push", ...changed }), /Broader validation required/);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  assert.equal(git(root, ["worktree", "list", "--porcelain"]), before);
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("deep receipt is reusable only for the same target and base", async (t) => {
  const { root, marker, target } = await fixture(t);
  const before = git(root, ["worktree", "list", "--porcelain"]);
  const receipt = await runTarget(root, target, { mode: "deep", ...changed });
  assert.equal(receipt.status, "passed-local");
  assert.equal(receipt.mode, "deep");
  assert.equal(receipt.commit, target.commit);
  assert.equal(receipt.base, target.base);
  assert.ok(receipt.results.every(({ status }) => status === "passed"));
  const markerBefore = await fs.readFile(marker, "utf8");
  const reused = await runTarget(root, target, { mode: "push", ...changed });
  assert.equal(reused.key, receipt.key);
  assert.ok(reused.completedAt >= receipt.completedAt);
  assert.equal(reused.reusedPortableReceiptCompletedAt, receipt.completedAt);
  assert.equal(reused.expiresAt, receipt.expiresAt);
  assert.equal(await fs.readFile(marker, "utf8"), markerBefore);
  const previousPython = process.env.PYTHON;
  process.env.PYTHON = "/synthetic/changed-python-override";
  try {
    await assert.rejects(runTarget(root, target, { mode: "push", ...changed }), /Broader validation required/);
  } finally {
    if (previousPython === undefined) delete process.env.PYTHON;
    else process.env.PYTHON = previousPython;
  }
  await assert.rejects(runTarget(root, { ...target, base: target.commit }, { mode: "push", ...changed }), /Broader validation required/);
  await put(root, "src/domain.ts", "// next synthetic target\n");
  git(root, ["add", "src/domain.ts"]);
  git(root, ["commit", "-m", "next synthetic target"]);
  const next = git(root, ["rev-parse", "HEAD"]);
  await assert.rejects(runTarget(root, { ...target, commit: next }, { mode: "push", ...changed }), /Broader validation required/);
  assert.equal(await fs.readFile(marker, "utf8"), markerBefore);
  assert.equal(git(root, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length,
    before.split("\n").filter((line) => line.startsWith("worktree ")).length);
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("failed deep result is preserved but never reused by push", async (t) => {
  const { root, marker, target } = await fixture(t, true);
  const before = git(root, ["worktree", "list", "--porcelain"]);
  await assert.rejects(runTarget(root, target, { mode: "deep", ...changed }), /validation failed; receipt retained/);
  const receiptDirectory = path.join(root, ".git", "local-checks");
  const receipts = (await fs.readdir(receiptDirectory)).filter((name) => name.endsWith(".json"));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(await fs.readFile(path.join(receiptDirectory, receipts[0]), "utf8"));
  assert.equal(receipt.status, "failed");
  assert.ok(receipt.results.some(({ id, status }) => id === "synthetic-broad" && status === "failed"));
  const markerBefore = await fs.readFile(marker, "utf8");
  await assert.rejects(runTarget(root, target, { mode: "push", ...changed }), /Broader validation required/);
  assert.equal(await fs.readFile(marker, "utf8"), markerBefore);
  assert.equal(git(root, ["worktree", "list", "--porcelain"]), before);
});


async function commitFixture(root, message) {
  git(root, ["add", "."]);
  git(root, ["commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

async function readReceipt(root, key) {
  const file = path.join(root, ".git", "local-checks", `${key}.json`);
  return { file, value: JSON.parse(await fs.readFile(file, "utf8")) };
}

test("P03 actual snapshot discovery detects new consumers before cache reuse", async (t) => {
  const { root, target, graphFixture } = await fixture(t);
  const original = await runTarget(root, target, { mode: "deep", ...changed });
  await graphFixture.write("tests_js/new-consumer.test.mjs", `import '../${GRAPH_RUNTIME}';\n`);
  const commit = await commitFixture(root, "new tracked consumer");
  await assert.rejects(runTarget(root, { ...target, commit }, { mode: "push", paths: [] }), /Broader validation required/);
  const next = await runTarget(root, { ...target, commit }, { mode: "deep", paths: [] });
  assert.notEqual(next.graph, original.graph);
  assert.notEqual(next.key, original.key);
  assert.ok(next.suites.some(s => s.id === "synthetic-broad"));
  assert.ok(next.suites.filter(s => s.id.startsWith("native-posix-")).flatMap(s => s.include).length === 6);
  await fs.rm(path.join(root, "tests_js/posix_flock.test.mjs"));
  const missingNative = await commitFixture(root, "remove mandatory native root");
  await assert.rejects(runTarget(root, { ...target, commit: missingNative }, { mode: "deep", paths: [] }), /Mandatory native root unavailable: tests_js\/posix_flock.test.mjs/);
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("P03 actual selected consumer failures skips and missing results cannot satisfy cached acceptance", async (t) => {
  const { root, target, graphFixture, nativeFailure } = await fixture(t);
  const matrix = JSON.parse(await fs.readFile(path.join(root, "config/test-matrix.json")));
  matrix.suites[0].command = [process.execPath, "-e", [
    "process.stdout.write('\\n\\n  \\t\\r\\npart');process.stderr.write('\\n\\nerr');",
    "setTimeout(()=>{process.stdout.write('ial\\nlast');process.stderr.write(' tail\\n')},20);",
  ].join("")];
  await put(root, "config/test-matrix.json", JSON.stringify(matrix));
  const commit = await commitFixture(root, "observed reporter child");
  const current = { ...target, commit };
  const receipt = await runTarget(root, current, { mode: "deep", ...changed });
  const log = await fs.readFile(path.join(root, ".git", "local-checks", `${receipt.key}.log`), "utf8");
  assert.ok(log.includes("[synthetic-broad]\n[synthetic-broad]\n[synthetic-broad]   \t\r\n[synthetic-broad] part"));
  assert.ok(log.includes("[synthetic-broad]\n[synthetic-broad]\n[synthetic-broad] err"));
  assert.ok(log.includes("ial\n[synthetic-broad] last"));
  assert.ok(log.includes(" tail\n"));
  assert.equal(log.includes("[synthetic-broad] \n"), false);
  const stored = await readReceipt(root, receipt.key);
  for (const status of ["failed", "skipped", "timed-out"]) {
    const altered = structuredClone(receipt);
    altered.results.find(r => r.id === "synthetic-broad").status = status;
    await fs.writeFile(stored.file, JSON.stringify(altered));
    await assert.rejects(runTarget(root, current, { mode: "push", ...changed }), /Broader validation required/);
  }
  await fs.writeFile(stored.file, JSON.stringify({ ...receipt, results: receipt.results.filter(r => r.id !== "synthetic-broad") }));
  await assert.rejects(runTarget(root, current, { mode: "push", ...changed }), /Broader validation required/);
  await fs.writeFile(stored.file, JSON.stringify(receipt));
  const fresh = await runTarget(root, current, { mode: "push", ...changed });
  assert.equal(fresh.reusedPortableReceiptCompletedAt, receipt.completedAt);
  assert.equal(fresh.expiresAt, receipt.expiresAt);
  const nativeLog = await fs.readFile(path.join(root, ".git", "local-checks", `${fresh.key}.log`), "utf8");
  assert.equal((nativeLog.match(/\[native-posix-lock\] # Subtest: owned native substitute/g) ?? []).length, 5);
  assert.equal((nativeLog.match(/\[native-posix-timestamps\] # Subtest: owned native substitute/g) ?? []).length, 1);
  assert.equal(nativeLog.includes("[synthetic-broad]"), false);
  assert.ok(fresh.results.filter(r => r.id.startsWith("native-posix-")).every(r => r.status === "passed"));

  await fs.writeFile(nativeFailure, "fail fresh owned native execution");
  await assert.rejects(runTarget(root, current, { mode: "push", ...changed }), /validation failed/);
  const failedNative = (await readReceipt(root, receipt.key)).value;
  assert.equal(failedNative.status, "failed");
  assert.equal(failedNative.expiresAt, receipt.expiresAt);
  assert.equal(failedNative.results.find(r => r.id === "native-posix-timestamps").status, "failed");
  await fs.rm(nativeFailure);
  await assert.rejects(runTarget(root, current, { mode: "push", ...changed }), /Broader validation required/);

  // Real selected dependency failure, not only receipt-shape mutation.
  graphFixture.contract.rules[0].heavyTests = [GRAPH_CHILD];
  graphFixture.contract.rules[0].lightTests = [GRAPH_TEST];
  await graphFixture.writeContract();
  await graphFixture.write(GRAPH_RUNTIME, "export const value = 2;\n");
  const mutant = await commitFixture(root, "failing selected runtime consumer");
  await assert.rejects(runTarget(root, { ...target, commit: mutant }, { mode: "deep", paths: [GRAPH_RUNTIME] }), /validation failed/);
  assert.equal(git(root, ["status", "--porcelain"]), "");
});

test("P03 actual dirty owner and merge snapshots bind the exact tested dependency graph", async (t) => {
  const { root, target } = await fixture(t);
  const before = git(root, ["worktree", "list", "--porcelain"]);
  await put(root, GRAPH_RUNTIME, "export const value = 99;\n");
  await put(root, "owner-private.txt", "untracked owned text\n");
  const dirty = git(root, ["status", "--porcelain"]);
  const receipt = await runTarget(root, target, { mode: "deep", ...changed });
  assert.equal(receipt.tree, git(root, ["rev-parse", `${target.commit}^{tree}`]));
  assert.equal(git(root, ["status", "--porcelain"]), dirty);
  assert.equal(await fs.readFile(path.join(root, GRAPH_RUNTIME), "utf8"), "export const value = 99;\n");
  assert.equal(git(root, ["worktree", "list", "--porcelain"]), before);
  git(root, ["restore", GRAPH_RUNTIME]);
  await fs.rm(path.join(root, "owner-private.txt"));
  git(root, ["checkout", "-b", "consumer-branch"]);
  await put(root, "README.md", "branch documentation\n");
  const branch = await commitFixture(root, "branch docs");
  git(root, ["checkout", "main"]);
  await put(root, "other.txt", "independent change\n");
  await commitFixture(root, "main independent file");
  git(root, ["merge", "--no-ff", branch, "-m", "synthetic merge"]);
  const merge = git(root, ["rev-parse", "HEAD"]);
  const merged = await runTarget(root, { ...target, commit: merge }, { mode: "deep", paths: ["README.md", "other.txt"] });
  assert.equal(merged.tree, git(root, ["rev-parse", `${merge}^{tree}`]));
  assert.notEqual(merged.key, receipt.key);
  assert.equal(git(root, ["status", "--porcelain"]), "");
});
