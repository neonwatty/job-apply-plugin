import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditCoreWorkflowRegistry,
  evidenceLanes,
  readCoreWorkflowRegistry,
} from "../tools/audit-core-workflows.mjs";
import {
  committedWorkflowPaths,
  parseValidatorResult,
  validateAgentWorkflows,
  workflowRunnerPath,
} from "../tools/validate-agent-workflows.mjs";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

test("every committed Agent Workflow validates and has one truthful registry row", () => {
  const validation = validateAgentWorkflows({ root: rootPath });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const registry = readCoreWorkflowRegistry(rootPath);
  assert.deepEqual(auditCoreWorkflowRegistry(registry, validation), []);
  assert.deepEqual(
    registry.workflows.map((row) => row.workflowPath).sort(),
    committedWorkflowPaths(rootPath),
  );
  for (const row of registry.workflows) {
    assert.deepEqual(Object.keys(row.evidence).sort(), [...evidenceLanes].sort());
    assert.ok(row.uxSurfaces.length > 0);
    assert.ok(row.cliEntrypoints.length > 0);
    assert.ok(row.tests.length > 0);
    for (const lane of evidenceLanes) {
      const evidence = row.evidence[lane];
      if (evidence.status === "verified") {
        assert.ok(evidence.sources.length > 0 || evidence.receiptRefs.length > 0);
      }
      assert.ok(evidence.note.length > 0);
    }
  }
});

test("validator JSON ok is authoritative even when the process can exit successfully", () => {
  const result = parseValidatorResult('{"ok":false,"error":{"code":"VALIDATION_FAILED"}}', "fixture.workflow.yaml");
  assert.equal(result.ok, false);
  assert.throws(() => parseValidatorResult("not json", "fixture.workflow.yaml"), /did not return one JSON result/);
});

test("workflow validator invokes the package JavaScript entry point through Node", () => {
  const expected = "/repo/node_modules/@lineagehq/workflows/bin/workflow.js";
  assert.equal(workflowRunnerPath("/repo", "win32"), expected);
  assert.equal(workflowRunnerPath("/repo", "darwin"), expected);
});

test("registry audit rejects invalid and unmapped workflows", () => {
  const registry = readCoreWorkflowRegistry(rootPath);
  const invalid = {
    ok: false,
    results: [{ workflowPath: "missing.workflow.yaml", ok: false, result: { ok: false } }],
  };
  const errors = auditCoreWorkflowRegistry(registry, invalid);
  assert.ok(errors.includes("one or more committed Agent Workflows are invalid"));
  assert.ok(errors.includes("unmapped committed workflow: missing.workflow.yaml"));
});

test("registry audit rejects stale UX, CLI, test, and evidence mappings", () => {
  const registry = structuredClone(readCoreWorkflowRegistry(rootPath));
  const validation = validateAgentWorkflows({ root: rootPath });
  registry.workflows[0].uxSurfaces = ["Removed surface"];
  registry.workflows[0].cliEntrypoints = ["missing-cli-entrypoint.mjs"];
  registry.workflows[0].tests = ["missing-test.mjs"];
  registry.workflows[0].evidence.deterministicLocal.sources = ["missing-receipt.md"];
  const errors = auditCoreWorkflowRegistry(registry, validation, { root: rootPath });
  assert.ok(errors.includes(`${registry.workflows[0].id}: unknown Companion surface Removed surface`));
  assert.ok(errors.includes(`${registry.workflows[0].id}: cliEntrypoints path does not exist: missing-cli-entrypoint.mjs`));
  assert.ok(errors.includes(`${registry.workflows[0].id}: tests path does not exist: missing-test.mjs`));
  assert.ok(errors.includes(`${registry.workflows[0].id}: deterministicLocal source does not exist: missing-receipt.md`));
});

test("registry mappings require concrete files and real test paths", () => {
  const registry = structuredClone(readCoreWorkflowRegistry(rootPath));
  const validation = validateAgentWorkflows({ root: rootPath });
  registry.workflows[0].cliEntrypoints = ["skills"];
  registry.workflows[0].tests = ["README.md"];
  registry.workflows[0].evidence.deterministicLocal.sources = ["docs"];
  const errors = auditCoreWorkflowRegistry(registry, validation, { root: rootPath });
  assert.ok(errors.includes(`${registry.workflows[0].id}: cliEntrypoints path must be a file: skills`));
  assert.ok(errors.includes(`${registry.workflows[0].id}: tests must reference a tests/ or tests_js/ file: README.md`));
  assert.ok(errors.includes(`${registry.workflows[0].id}: deterministicLocal source must be a file: docs`));
  assert.ok(errors.includes(`${registry.workflows[0].id}: deterministicLocal verification requires a committed test source`));
});

test("registry mappings require an explicit workflow-to-behavioral-test binding", () => {
  const registry = structuredClone(readCoreWorkflowRegistry(rootPath));
  const validation = validateAgentWorkflows({ root: rootPath });
  registry.workflows[0].tests = ["tests_js/atomic_write_json_ts.test.mjs"];
  registry.workflows[0].evidence.deterministicLocal.sources = ["tests_js/atomic_write_json_ts.test.mjs"];
  const errors = auditCoreWorkflowRegistry(registry, validation, { root: rootPath });
  assert.ok(errors.includes(`${registry.workflows[0].id}: mapped test must name the workflow id: tests_js/atomic_write_json_ts.test.mjs`));
  assert.ok(errors.includes(`${registry.workflows[0].id}: deterministicLocal verification must cite a workflow-bound mapped test`));
});

test("registry audit validates exact handoff placement", () => {
  const registry = structuredClone(readCoreWorkflowRegistry(rootPath));
  const validation = validateAgentWorkflows({ root: rootPath });
  registry.companion.applicationHandoff.surfaces = ["Trash"];
  registry.companion.resumeExtractionHandoff.surface = "Jobs";
  const errors = auditCoreWorkflowRegistry(registry, validation, { root: rootPath });
  assert.ok(errors.includes("companion application handoff must retain the exact copy-only invocations"));
  assert.ok(errors.includes("companion resume extraction handoff must retain the value-free request template"));
});

test("verified evidence requires a committed lane-appropriate source", () => {
  const registry = structuredClone(readCoreWorkflowRegistry(rootPath));
  const validation = validateAgentWorkflows({ root: rootPath });
  registry.workflows[0].evidence.installedHost.status = "verified";
  registry.workflows[0].evidence.installedHost.receiptRefs = ["T999"];
  const errors = auditCoreWorkflowRegistry(registry, validation, { root: rootPath });
  assert.ok(errors.includes(`${registry.workflows[0].id}: installedHost receiptRefs are ambiguous; commit durable receipt files in sources`));
  assert.ok(errors.includes(`${registry.workflows[0].id}: installedHost verification requires a committed dogfooding receipt`));
});

test("synthetic and aggregate ATS evidence cannot be silently upgraded", () => {
  const registry = structuredClone(readCoreWorkflowRegistry(rootPath));
  const validation = validateAgentWorkflows({ root: rootPath });
  registry.workflows[0].evidence.currentLiveAts = {
    status: "verified", sources: ["package.json"], receiptRefs: [], note: "invented",
  };
  registry.atsReadinessEvidence.currentLiveAts = { status: "verified", sources: [] };
  const errors = auditCoreWorkflowRegistry(registry, validation, { root: rootPath });
  assert.ok(errors.includes(`${registry.workflows[0].id}: synthetic workflows cannot claim currentLiveAts evidence`));
  assert.ok(errors.includes("global currentLiveAts must remain unverified without sources"));
  delete registry.atsReadinessEvidence;
  const missing = auditCoreWorkflowRegistry(registry, validation, { root: rootPath });
  assert.ok(missing.includes("atsReadinessEvidence catalogs must be a non-empty array"));
  assert.ok(missing.includes("global currentLiveAts must remain unverified without sources"));
});
