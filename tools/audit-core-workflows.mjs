#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateAgentWorkflows } from "./validate-agent-workflows.mjs";

const modulePath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(modulePath), "..");
export const evidenceLanes = [
  "deterministicLocal",
  "installedHost",
  "replay",
  "currentLiveAts",
];
const evidenceStatuses = new Set(["verified", "unverified", "blocked", "not-applicable"]);
const deterministicTestRoots = ["tests/", "tests_js/"];
const durableEvidenceRoot = "docs/dogfooding/";

export function readCoreWorkflowRegistry(root = defaultRoot) {
  return JSON.parse(readFileSync(path.join(root, "config", "core-workflows.json"), "utf8"));
}

function concreteFileError(root, value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    return "must be a non-empty repository-relative path";
  }
  const candidate = path.resolve(root, value);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "escapes the repository";
  if (!existsSync(candidate)) return "does not exist";
  if (!statSync(candidate).isFile()) return "must be a file";
  const real = realpathSync(candidate);
  const realRelative = path.relative(realpathSync(root), real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return "escapes the repository";
  return null;
}

function checkPathList(errors, root, row, field) {
  const values = row?.[field];
  if (!Array.isArray(values) || values.length === 0) {
    errors.push(`${row?.id ?? "unknown"}: ${field} must be a non-empty array`);
    return;
  }
  for (const value of values) {
    const problem = concreteFileError(root, value);
    if (problem) errors.push(`${row.id}: ${field} path ${problem}: ${value}`);
    if (!problem && field === "tests" && !deterministicTestRoots.some((prefix) => value.startsWith(prefix))) {
      errors.push(`${row.id}: tests must reference a tests/ or tests_js/ file: ${value}`);
    }
  }
}

function checkWorkflowTestBinding(errors, root, row) {
  if (typeof row?.id !== "string" || row.id.length === 0) return;
  const tests = Array.isArray(row?.tests) ? row.tests : [];
  const boundTests = tests.filter((testPath) => {
    if (concreteFileError(root, testPath)) return false;
    return readFileSync(path.resolve(root, testPath), "utf8").includes(row.id);
  });
  for (const testPath of tests.filter((testPath) => !boundTests.includes(testPath))) {
    errors.push(`${row.id}: mapped test must name the workflow id: ${testPath}`);
  }
  if (row?.evidence?.deterministicLocal?.status === "verified"
      && !boundTests.some((testPath) => row.evidence.deterministicLocal.sources?.includes(testPath))) {
    errors.push(`${row.id}: deterministicLocal verification must cite a workflow-bound mapped test`);
  }
}

export function auditCoreWorkflowRegistry(registry, validation, { root = defaultRoot } = {}) {
  const errors = [];
  if (registry?.schemaVersion !== 2) errors.push("registry schemaVersion must be 2");
  if (!Array.isArray(registry?.workflows)) errors.push("registry workflows must be an array");
  if (!validation?.ok) errors.push("one or more committed Agent Workflows are invalid");
  const companionSurfaces = registry?.companion?.surfaces;
  if (!Array.isArray(companionSurfaces) || companionSurfaces.length === 0) {
    errors.push("companion surfaces must be a non-empty array");
  }
  if (registry?.companion?.startupSurface !== "Overview") {
    errors.push("companion startupSurface must be Overview");
  }
  const applicationHandoff = registry?.companion?.applicationHandoff;
  if (applicationHandoff?.kind !== "copy-only"
      || applicationHandoff?.codex !== "$job-apply:job-apply"
      || applicationHandoff?.claude !== "/job-apply:job-apply"
      || JSON.stringify(applicationHandoff?.surfaces) !== JSON.stringify(["Overview", "Jobs"])) {
    errors.push("companion application handoff must retain the exact copy-only invocations");
  }
  const extractionHandoff = registry?.companion?.resumeExtractionHandoff;
  if (extractionHandoff?.kind !== "copy-only"
      || extractionHandoff?.surface !== "Resumes"
      || extractionHandoff?.onlyMutableValue !== "opaque request ID"
      || extractionHandoff?.template !== "Use the Job Apply resume workflow to process extraction request <request-id>.") {
    errors.push("companion resume extraction handoff must retain the value-free request template");
  }
  const rows = Array.isArray(registry?.workflows) ? registry.workflows : [];
  const byPath = new Map();
  const ids = new Set();
  for (const row of rows) {
    if (!row?.id || ids.has(row.id)) errors.push(`duplicate or empty registry id: ${row?.id}`);
    ids.add(row?.id);
    if (!row?.workflowPath || byPath.has(row.workflowPath)) {
      errors.push(`duplicate or empty workflowPath: ${row?.workflowPath}`);
    }
    byPath.set(row?.workflowPath, row);
    checkPathList(errors, root, row, "cliEntrypoints");
    checkPathList(errors, root, row, "tests");
    checkWorkflowTestBinding(errors, root, row);
    if (!Array.isArray(row?.uxSurfaces) || row.uxSurfaces.length === 0) {
      errors.push(`${row?.id ?? "unknown"}: uxSurfaces must be a non-empty array`);
    } else {
      for (const surface of row.uxSurfaces) {
        if (!companionSurfaces?.includes(surface)) {
          errors.push(`${row.id}: unknown Companion surface ${surface}`);
        }
      }
    }
    for (const lane of evidenceLanes) {
      const evidence = row?.evidence?.[lane];
      if (!evidenceStatuses.has(evidence?.status)) {
        errors.push(`${row?.id ?? "unknown"}: ${lane} has invalid evidence status`);
        continue;
      }
      if (!Array.isArray(evidence.sources)) {
        errors.push(`${row.id}: ${lane} sources must be an array`);
      } else {
        for (const source of evidence.sources) {
          const problem = concreteFileError(root, source);
          if (problem) errors.push(`${row.id}: ${lane} source ${problem}: ${source}`);
        }
      }
      if (!Array.isArray(evidence.receiptRefs)) {
        errors.push(`${row.id}: ${lane} receiptRefs must be an array`);
      } else if (evidence.receiptRefs.length !== 0) {
        errors.push(`${row.id}: ${lane} receiptRefs are ambiguous; commit durable receipt files in sources`);
      }
      if (evidence.status === "verified"
          && Array.isArray(evidence.sources)
          && evidence.sources.length === 0) {
        errors.push(`${row.id}: ${lane} cannot be verified without a committed source file`);
      }
      if (evidence.status === "verified" && lane === "deterministicLocal"
          && !evidence.sources?.some((source) => deterministicTestRoots.some((prefix) => source.startsWith(prefix)))) {
        errors.push(`${row.id}: deterministicLocal verification requires a committed test source`);
      }
      if (evidence.status === "verified" && ["installedHost", "replay"].includes(lane)
          && !evidence.sources?.some((source) => source.startsWith(durableEvidenceRoot))) {
        errors.push(`${row.id}: ${lane} verification requires a committed dogfooding receipt`);
      }
      if (lane === "currentLiveAts" && row?.id?.startsWith("job-apply.synthetic-")
          && (evidence.status !== "not-applicable" || evidence.sources?.length || evidence.receiptRefs?.length)) {
        errors.push(`${row.id}: synthetic workflows cannot claim currentLiveAts evidence`);
      }
      if (typeof evidence.note !== "string" || evidence.note.length === 0) {
        errors.push(`${row.id}: ${lane} must explain its evidence boundary`);
      }
    }
    const extraLanes = Object.keys(row?.evidence ?? {}).filter((lane) => !evidenceLanes.includes(lane));
    if (extraLanes.length) errors.push(`${row?.id ?? "unknown"}: unknown evidence lanes ${extraLanes.join(", ")}`);
  }
  for (const item of validation?.results ?? []) {
    const row = byPath.get(item.workflowPath);
    if (!row) {
      errors.push(`unmapped committed workflow: ${item.workflowPath}`);
      continue;
    }
    const validatedIds = item.result?.data?.items?.map((entry) => entry.id) ?? [];
    if (item.ok && (validatedIds.length !== 1 || validatedIds[0] !== row.id)) {
      errors.push(`${item.workflowPath}: registry id does not match validator result`);
    }
  }
  const committed = new Set((validation?.results ?? []).map((item) => item.workflowPath));
  for (const workflowPath of byPath.keys()) {
    if (!committed.has(workflowPath)) errors.push(`registry maps no committed workflow: ${workflowPath}`);
  }
  const atsReadiness = registry?.atsReadinessEvidence;
  if (!Array.isArray(atsReadiness?.catalogs) || atsReadiness.catalogs.length === 0) {
    errors.push("atsReadinessEvidence catalogs must be a non-empty array");
  } else {
    for (const catalog of atsReadiness.catalogs) {
      if (typeof catalog?.fixtureId !== "string" || catalog.evidenceKind !== "hand-authored-synthetic"
          || catalog.currentLiveAtsStatus !== "unverified") {
        errors.push("ATS readiness catalogs must remain identified as hand-authored synthetic and live-unverified");
      }
    }
  }
  if (typeof atsReadiness?.note !== "string" || atsReadiness.note.length === 0) {
    errors.push("atsReadinessEvidence must explain its evidence boundary");
  }
  if (atsReadiness?.currentLiveAts?.status !== "unverified"
      || !Array.isArray(atsReadiness?.currentLiveAts?.sources)
      || atsReadiness.currentLiveAts.sources.length !== 0) {
    errors.push("global currentLiveAts must remain unverified without sources");
  }
  return errors;
}

function summarizeEvidence(registry) {
  return Object.fromEntries(evidenceLanes.map((lane) => [lane,
    Object.fromEntries([...evidenceStatuses].map((status) => [status,
      registry.workflows.filter((row) => row.evidence[lane].status === status).length,
    ])),
  ]));
}

export function runCoreWorkflowAudit(root = defaultRoot) {
  const validation = validateAgentWorkflows({ root });
  const registry = readCoreWorkflowRegistry(root);
  const errors = auditCoreWorkflowRegistry(registry, validation, { root });
  return {
    ok: errors.length === 0,
    workflowCount: validation.results.length,
    registryCount: registry.workflows?.length ?? 0,
    evidenceSummary: summarizeEvidence(registry),
    currentLiveAtsStatus: registry.atsReadinessEvidence?.currentLiveAts?.status ?? "unverified",
    errors,
    validation,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const report = runCoreWorkflowAudit();
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}
