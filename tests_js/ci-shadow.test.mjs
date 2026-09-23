import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classify, parseArguments } from "../tools/ci/classify.mjs";
import { evaluateGate, main as gateMain } from "../tools/ci/gate.mjs";

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

test("gate CLI configuration fails closed when missing or empty", () => {
  assert.throws(() => gateMain({}), /are required/);
  assert.throws(() => gateMain({ CI_RESULTS_JSON: "{}", CI_SELECTED_JOBS: "[]" }), /must not be empty/);
});

test("Windows validation budget covers the complete protected Store and workspace suites", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  assert.match(workflow, /windows-store-workspace:\n[\s\S]*?timeout-minutes: 30\n[\s\S]*?macos-credential-helper:/);
});

test("every CI-portable full-only suite is assigned to a required validation shard", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, "config/test-matrix.json"), "utf8"));
  const fullOnly = matrix.suites.filter(suite => suite.tiers.includes("full") && !suite.tiers.includes("fast"));
  const localOrHistorical = new Set(["native-frozen-reference-profiles", "node-reference-s04", "node-reference-s05"]);
  const assigned = [...workflow.matchAll(/suite: \[([^\]]+)\]/g)]
    .flatMap(match => match[1].split(",").map(value => value.trim()));
  for (const suite of fullOnly.filter(value => !localOrHistorical.has(value.id))) {
    assert.equal(assigned.includes(suite.id), true, `CI-portable full suite is not assigned: ${suite.id}`);
  }
  for (const id of localOrHistorical) assert.equal(assigned.includes(id), false, `local or historical suite entered hosted CI: ${id}`);

  const macStart = workflow.indexOf("  macos-typescript-shards:");
  const macEnd = workflow.indexOf("\n  package-contract:", macStart);
  const macShards = workflow.slice(macStart, macEnd);
  for (const suite of fullOnly.filter(value => value.platforms?.every(platform => platform === "darwin") && !localOrHistorical.has(value.id))) {
    assert.match(macShards, new RegExp(`\\b${suite.id}\\b`));
  }
  assert.match(workflow, /needs: \[[^\]]*macos-typescript-shards[^\]]*\]/);
  assert.match(workflow, /CI_SELECTED_JOBS: '[^']*macos-typescript-shards[^']*'/);
  assert.match(workflow, /if: matrix\.suite == 'node-migration-evidence'[\s\S]*?git config --global user\.name[\s\S]*?git config --global user\.email/);
});

test("validation workflow preserves contexts, replaces stale modules, and keeps shadow full execution", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  for (const id of ["python-shards:", "browser-shards:", "macos-typescript-shards:", "package-contract:", "windows-store-workspace:", "macos-credential-helper:", "macos-account-flow-helper:"]) {
    assert.match(workflow, new RegExp(`^  ${id}`, "m"));
  }
  assert.doesNotMatch(workflow, /tests\.test_job_apply_(?:store|workspace)(?:\s|$)/m);
  assert.doesNotMatch(workflow, /tests\.test_qa_chrome(?:\s|$)/m);
  assert.doesNotMatch(workflow, /^  validate:/m);
  assert.doesNotMatch(workflow, /"validate"|JOB_APPLY_SKIP_LEGACY_PACKAGED_CRUD/);
  assert.match(workflow, /run-suite\.mjs release-package/);
  for (const module of workflow.matchAll(/tests\.(test_[A-Za-z0-9_]+)/g)) {
    assert.equal(fs.existsSync(path.join(ROOT, "tests", `${module[1]}.py`)), true, `missing ${module[0]}`);
  }
  assert.match(workflow, /name: PR gate/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /Shadow only: full deterministic shards still execute/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /push:\n    branches: \[main, staging\]/);
  assert.match(workflow, /pull_request:\n    branches: \[main, staging\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /policy:[\s\S]*?actions\/checkout@v4\n        with:\n          fetch-depth: 0[\s\S]*?python-shards:/);
  assert.doesNotMatch(workflow, /owner-approved-visible-browser-tests/);
  const nightly = fs.readFileSync(path.join(ROOT, ".github/workflows/nightly.yml"), "utf8");
  assert.match(nightly, /workflow_dispatch:/);
  assert.match(nightly, /deterministic-full:[\s\S]*?fetch-depth: 0[\s\S]*?macos-live-advisory:/);
  assert.match(nightly, /npm run test:release -- --receipt/);
  assert.match(nightly, /owner-approved-visible-browser-tests/);
  assert.match(nightly, /continue-on-error: true/);
});
