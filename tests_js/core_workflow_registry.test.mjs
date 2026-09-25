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

test("verified evidence requires a durable source or task receipt", () => {
  const registry = structuredClone(readCoreWorkflowRegistry(rootPath));
  const validation = validateAgentWorkflows({ root: rootPath });
  registry.workflows[0].evidence.installedHost.sources = [];
  registry.workflows[0].evidence.installedHost.receiptRefs = [];
  const errors = auditCoreWorkflowRegistry(registry, validation, { root: rootPath });
  assert.ok(errors.includes(`${registry.workflows[0].id}: installedHost cannot be verified without a source or receipt`));
});
