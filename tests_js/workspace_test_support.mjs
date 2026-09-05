import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = process.env.JOB_WORKSPACE_TEST_ROOT
  ? resolve(process.env.JOB_WORKSPACE_TEST_ROOT)
  : SOURCE_ROOT;
const PYTHON = process.env.PYTHON || "python3";

function minimalSyntheticPdf() {
  const header = "%PDF-1.7\n";
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
  ];
  const offsets = [];
  let body = header;
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body);
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(
    `${body}xref\n0 4\n0000000000 65535 f \n${entries}`
      + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
}

async function liveReviewSession(attemptRevision) {
  const fixture = JSON.parse(await readFile(
    join(REPO_ROOT, "qa", "fixtures", "greenhouse-form-readiness-v1", "fixture.json"),
    "utf8",
  ));
  const observationRevision = 17;
  const requiredControlIds = fixture.steps.flatMap((step) => step.controls)
    .filter((control) => control.required)
    .map((control) => control.id)
    .sort();
  const controlSetFingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    platformFamily: fixture.platformFamily, requiredControlIds,
  })).digest("hex")}`;
  return {
    status: "review",
    step: "review",
    pendingFields: [],
    answerKeys: [],
    attemptRevision,
    readinessInput: {
      attemptRevision,
      evidenceKind: "agent_attested_current_attempt",
      fixture,
      formManifest: {
        schemaVersion: 1,
        platformFamily: fixture.platformFamily,
        observationRevision,
        requiredControlIds,
        controlSetFingerprint,
        complete: true,
      },
      expectedObservationRevision: observationRevision,
      observation: {
        schemaVersion: 1,
        platformFamily: "greenhouse",
        observationRevision,
        adapterState: "accessible",
        uploadCapability: "available",
        controls: [
          { controlId: "authorization.sponsorship_select", kind: "selection", state: "complete", observationRevision },
          { controlId: "contact.first_name", kind: "text", state: "complete", observationRevision },
          { controlId: "contact.phone_country", kind: "selection", state: "complete", observationRevision },
          { controlId: "resume.file", kind: "upload", state: "accepted", observationRevision },
        ],
        validationErrorControlIds: [],
        finalControlState: "available",
      },
    },
  };
}

const {
  ApiError,
  activityAnnouncement,
  activitySignature,
  attentionAnnouncement,
  attentionBlockerSummary,
  attentionMembershipSignature,
  attentionMissingInformationText,
  answerApiPath,
  FACT_SAVE_REVISION_RETRIES,
  canMarkReadyFrom,
  answerNeedsFreshConsent,
  answerSummary,
  canApplyAnswerReveal,
  canApplyAnswerDialogResponse,
  canApplyAnswerDialogMutation,
  canRefreshAnswerDraft,
  canRevealAnswer,
  sameAnswerScope,
  createApi,
  createLatestRequestCoordinator,
  employerAccountOverrideRequest,
  extractionRequestView,
  conflictingPaths,
  filterJobs,
  formPatch,
  filterTrashItems,
  lifecycleErrorText,
  newestCanonicalJob,
  ownerBetaNextStep,
  patchForPaths,
  pointerValue,
  proposalGroupForPath,
  resumeAssignmentText,
  safeSessionStorage,
  sessionToken,
  shouldRetryFactSave,
  shouldUseActivityResponse,
  shouldUseResumeResponse,
  summarizeProvenance,
  tagsFromInput,
  trustedFillApprovalPacket,
  trustedFillRevokeRequest,
  trashBlockerText,
  tokenFromHash,
  transitionsFor,
  typedDeletePhrase,
} = await import(pathToFileURL(join(REPO_ROOT, "workspace", "app.js")).href);


export {
  assert,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  tmpdir,
  dirname,
  join,
  resolve,
  spawn,
  spawnSync,
  createHash,
  fileURLToPath,
  pathToFileURL,
  test,
  chromium,
  SOURCE_ROOT,
  REPO_ROOT,
  PYTHON,
  minimalSyntheticPdf,
  liveReviewSession,
  ApiError,
  activityAnnouncement,
  activitySignature,
  attentionAnnouncement,
  attentionBlockerSummary,
  attentionMembershipSignature,
  attentionMissingInformationText,
  answerApiPath,
  FACT_SAVE_REVISION_RETRIES,
  canMarkReadyFrom,
  answerNeedsFreshConsent,
  answerSummary,
  canApplyAnswerReveal,
  canApplyAnswerDialogResponse,
  canApplyAnswerDialogMutation,
  canRefreshAnswerDraft,
  canRevealAnswer,
  sameAnswerScope,
  createApi,
  createLatestRequestCoordinator,
  employerAccountOverrideRequest,
  extractionRequestView,
  conflictingPaths,
  filterJobs,
  formPatch,
  filterTrashItems,
  lifecycleErrorText,
  newestCanonicalJob,
  ownerBetaNextStep,
  patchForPaths,
  pointerValue,
  proposalGroupForPath,
  resumeAssignmentText,
  safeSessionStorage,
  sessionToken,
  shouldRetryFactSave,
  shouldUseActivityResponse,
  shouldUseResumeResponse,
  summarizeProvenance,
  tagsFromInput,
  trustedFillApprovalPacket,
  trustedFillRevokeRequest,
  trashBlockerText,
  tokenFromHash,
  transitionsFor,
  typedDeletePhrase,
};
