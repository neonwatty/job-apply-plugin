import {
  assert, attentionBlockerSummary, attentionMissingInformationText, employerAccountOverrideRequest,
  ownerBetaNextStep, test, trustedFillApprovalPacket, trustedFillRevokeRequest,
} from "./workspace_test_support.mjs";
import {
  cleanupOwnerBetaScenario, createOwnerBetaScenario, startOwnerBetaScenario,
} from "./workspace_owner_beta_scenario_support.mjs";
import {
  runOwnerBetaOverviewAndPreflightPhase, runOwnerBetaPollingRecoveryPhase,
} from "./workspace_owner_beta_overview_phases.mjs";
import { runOwnerBetaFreshnessRestartPhase } from "./workspace_owner_beta_recovery_phase.mjs";

test("realm email override requests bind the exact account revision and explicit clear", () => {
  const account = { realmRef: "a".repeat(64), revision: 7 };
  const save = employerAccountOverrideRequest(account, " owner@example.com ");
  assert.equal(save.path, `/api/employer-accounts/${"a".repeat(64)}`);
  assert.deepEqual(JSON.parse(save.options.body), {
    patch: { signupEmailOverride: "owner@example.com" },
    expectedRevision: 7,
  });
  assert.deepEqual(JSON.parse(employerAccountOverrideRequest(account, "", true).options.body), {
    patch: { signupEmailOverride: null },
    expectedRevision: 7,
  });
  assert.throws(() => employerAccountOverrideRequest({ realmRef: account.realmRef, revision: 0 }, ""), /canonical employer account revision/);
});

test("Trusted Fill browser requests remain fingerprint-only and revision-bound", () => {
  const fingerprint = (char) => `sha256:${char.repeat(64)}`;
  const packet = trustedFillApprovalPacket({
    jobId: "job-one", expectedJobRevision: "4", realmRef: "a".repeat(64),
    answerRefs: "question.b\nquestion.a\n", observedQuestionFingerprint: fingerprint("1"),
    observedControlFingerprint: fingerprint("2"), formFingerprint: fingerprint("3"),
    allowedOperations: ["select_option", "fill_text"], durationMinutes: "30",
  });
  assert.deepEqual(packet.answerRefs, ["question.b", "question.a"]);
  assert.deepEqual(packet.allowedOperations, ["fill_text", "select_option"]);
  assert.equal(packet.expectedJobRevision, 4);
  const revoke = trustedFillRevokeRequest({ jobId: "job-one", approvalRevision: 7 });
  assert.equal(revoke.path, "/api/trusted-fill/job-one/revoke");
  assert.deepEqual(JSON.parse(revoke.options.body), { expectedApprovalRevision: 7 });
  assert.throws(() => trustedFillRevokeRequest({ jobId: "job-one", approvalRevision: 0 }), /canonical Trusted Fill approval revision/);
});

test("owner beta next actions stay closed and human-readable", () => {
  assert.deepEqual(ownerBetaNextStep("import_resume"), [
    "Import a resume",
    "Add a private managed resume so agents have an approved document to use.",
  ]);
  assert.match(ownerBetaNextStep("handoff_ready_job")[1], /acquire the canonical Ready job/);
  assert.deepEqual(ownerBetaNextStep("unknown"), [
    "Review the workspace",
    "Refresh the canonical Store and choose a workspace section.",
  ]);
});

test("known-data entry failures present as browser action rather than missing information", () => {
  const item = {
    reasonCode: "browser_action_required",
    missingInformationCount: 0,
    session: {
      blockers: [
        { type: "browser_handoff", code: "unsupported-control" },
        { type: "information", code: "owner-input-required" },
      ],
      browserHandoff: { state: "required", reasonCode: "unsupported-control", revision: 1 },
    },
  };
  assert.equal(attentionMissingInformationText(item), "");
  assert.equal(attentionBlockerSummary(item), "Browser action required: unsupported control. Saved information is already known.");

  const mixed = {
    ...item,
    session: {
      ...item.session,
      blockers: [
        ...item.session.blockers,
        { type: "browser_handoff", code: "captcha-required" },
      ],
    },
  };
  assert.equal(attentionMissingInformationText(mixed), "");
  assert.equal(attentionBlockerSummary(mixed), "3 typed blockers: unsupported-control, owner-input-required, captcha-required");
});
