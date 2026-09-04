import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classify, parseArguments } from "../tools/ci/classify.mjs";
import { evaluateGate } from "../tools/ci/gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("shadow classification records affected selection without narrowing execution", () => {
  const matrix = {
    schemaVersion: 1,
    globalPaths: ["config/**"],
    suites: [
      { id: "fast", kind: "node-test", include: ["tests/fast.test.mjs"], tiers: ["fast", "full"] },
      { id: "slow", kind: "node-test", include: ["tests/slow.test.mjs"], tiers: ["full"] },
    ],
    ownership: [{ paths: ["src/slow/**"], suites: ["slow"] }],
  };
  const changes = { baseSha: "a", headSha: "b", changedPaths: ["src/slow/code.mjs"] };
  assert.deepEqual(classify(matrix, ["tests/fast.test.mjs", "tests/slow.test.mjs"], changes), {
    ...changes, suiteIds: ["fast", "slow"], fallbackReason: null,
  });
  assert.deepEqual(parseArguments(["--base", "HEAD~1", "--receipt", "out.json"]), {
    base: "HEAD~1", receipt: "out.json", githubOutput: null,
  });
  assert.throws(() => parseArguments(["--unknown", "value"]), /invalid argument/);
});

test("aggregate gate fails every selected non-success and ignores unselected skips", () => {
  const results = {
    policy: { result: "success" },
    python: { result: "failure" },
    windows: { result: "skipped" },
    macos: { result: "cancelled" },
    advisory: { result: "skipped" },
  };
  assert.deepEqual(evaluateGate(results, ["policy"]), { ok: true, failures: [] });
  assert.deepEqual(evaluateGate(results, ["policy", "python", "windows", "macos", "missing"]), {
    ok: false,
    failures: [
      { job: "python", status: "failure" },
      { job: "windows", status: "skipped" },
      { job: "macos", status: "cancelled" },
      { job: "missing", status: "missing" },
    ],
  });
});

test("validation workflow preserves contexts, replaces stale modules, and keeps shadow full execution", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  for (const id of ["validate:", "windows-store-workspace:", "macos-credential-helper:", "macos-account-flow-helper:"]) {
    assert.match(workflow, new RegExp(`^  ${id}`, "m"));
  }
  assert.doesNotMatch(workflow, /tests\.test_job_apply_(?:store|workspace)(?:\s|$)/m);
  assert.doesNotMatch(workflow, /tests\.test_qa_chrome(?:\s|$)/m);
  for (const module of [
    "test_job_apply_accounts", "test_job_apply_credentials", "test_job_apply_account_executor",
    "test_job_apply_account_canary", "test_job_apply_account_canary_executor",
    "test_job_apply_account_flows", "test_qa_account",
  ]) assert.match(workflow, new RegExp(`tests\\.${module}`));
  assert.match(workflow, /test_store_\*\.py/);
  assert.match(workflow, /test_job_apply_workspace_\*\.py/);
  assert.match(workflow, /test_qa_chrome_\*\.py/);
  for (const module of workflow.matchAll(/tests\.(test_[A-Za-z0-9_]+)/g)) {
    assert.equal(fs.existsSync(path.join(ROOT, "tests", `${module[1]}.py`)), true, `missing ${module[0]}`);
  }
  assert.match(workflow, /name: PR gate/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /Shadow only: full deterministic shards still execute/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.doesNotMatch(workflow, /owner-approved-visible-browser-tests/);
  const nightly = fs.readFileSync(path.join(ROOT, ".github/workflows/nightly.yml"), "utf8");
  assert.match(nightly, /workflow_dispatch:/);
  assert.match(nightly, /owner-approved-visible-browser-tests/);
  assert.match(nightly, /continue-on-error: true/);
});
