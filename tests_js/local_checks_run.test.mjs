import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTarget } from "../tools/local-checks/run.mjs";

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
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "local-checks-run-fixture-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "repo");
  await fs.mkdir(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Synthetic Local Checks"]);
  git(root, ["config", "user.email", "synthetic@example.invalid"]);
  const marker = path.join(temporary, "executions.txt");
  const record = `require('node:fs').appendFileSync(${JSON.stringify(marker)},'ran\\n');process.exitCode=${fail ? 5 : 0};`;
  const matrix = {
    schemaVersion: 1,
    inventory: { include: [] },
    fullInventory: { include: [] },
    globalPaths: ["src/**"],
    suites: [{ id: "synthetic-broad", kind: "command", command: [process.execPath, "-e", record], tiers: ["full"], timeoutMs: 1000 }],
    ownership: [],
  };
  await put(root, ".gitignore", "node_modules/\n");
  await put(root, "config/test-matrix.json", JSON.stringify(matrix));
  await put(root, "package.json", JSON.stringify({ private: true, scripts: { "build:check": "node -e \"process.exit(0)\"" } }));
  const lock = JSON.stringify({ name: "synthetic", lockfileVersion: 3, packages: {} });
  await put(root, "package-lock.json", lock);
  await put(root, "node_modules/.package-lock.json", lock);
  await put(root, "tools/local-checks/links.mjs", "// Synthetic no-op link validation.\n");
  await put(root, "src/domain.ts", "// synthetic base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "synthetic base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  await put(root, "src/domain.ts", "// synthetic target\n");
  git(root, ["add", "src/domain.ts"]);
  git(root, ["commit", "-m", "synthetic target"]);
  return { root, marker, target: { base, commit: git(root, ["rev-parse", "HEAD"]), tag: false } };
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
  assert.equal(reused.completedAt, receipt.completedAt);
  assert.equal(await fs.readFile(marker, "utf8"), markerBefore);
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
