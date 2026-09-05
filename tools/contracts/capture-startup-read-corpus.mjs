import { FIXED_CLOCK, commandInventory } from "./python-store.mjs";
import {
  changedPaths, fileEffect, withOwnedStoreFixture,
} from "./owned-store-fixture.mjs";
import {
  absolutePathPresent, redactionViolations, secretCanaryPresent,
} from "./vector-format.mjs";
import { canonicalStartupCorpus } from "./startup-vector-format.mjs";

const CAPTURED = ["automation-settings-get", "employer-account-list", "claim-status"];
const CANARY = "CONTRACT_SECRET_CANARY_STARTUP_PRIVATE";
const ACCOUNT_FILES = [
  "account-operation-journal.json", "automation-settings.json", "employer-accounts.json",
];
const COORDINATOR_FILES = ["coordinator-journal.json", "coordinator.json"];

const ACCOUNT_OPERATION = {
  operationId: "contract-operation", jobId: "contract-job", jobRevision: 1,
  claimId: CANARY, realmRef: "realm_contract", accountRevision: 1,
  settingsRevision: 1, stage: "prepared", outcomeCode: "observed_pending",
  startedAt: FIXED_CLOCK,
};

const RECOVERY_EVENT = {
  schemaVersion: 1, eventId: "coordinator-contract-recovery", applicationId: "contract-job",
  event: "claim-recovered", status: "in_progress", answerKeys: [], at: FIXED_CLOCK,
  company: CANARY,
};
const RECOVERY_CLAIM = {
  claimId: "contract-recovery-claim", jobId: "contract-job", ownerLabel: "contract-agent",
  tokenHash: "c".repeat(64), acquiredAt: FIXED_CLOCK, heartbeatAt: FIXED_CLOCK,
  expiresAt: "2026-09-05T00:05:00Z",
};
const RECOVERY_OPERATION = {
  kind: "recover", operationId: "contract-recovery", jobId: "contract-job",
  at: FIXED_CLOCK, historyEvent: RECOVERY_EVENT, resultClaim: RECOVERY_CLAIM,
};

function parsedStdout(result) {
  if (result.stdout === "") return null;
  try { return JSON.parse(result.stdout); } catch { throw new Error("python_stdout_invalid"); }
}

function sameResult(left, right) {
  return left.exitCode === right.exitCode && left.stdout === right.stdout
    && left.stderr === right.stderr && left.nonceCalls === right.nonceCalls;
}

async function captureCase({ scenario, command, setup, expectedWrites, rejection = false }) {
  return withOwnedStoreFixture(scenario, async (fixture) => {
    await setup(fixture);
    const before = await fixture.snapshot();
    const result = fixture.run([command]);
    const after = await fixture.snapshot();
    const observedWrites = changedPaths(before, after);
    if (JSON.stringify(observedWrites) !== JSON.stringify([...expectedWrites].sort())) {
      throw new Error("startup_write_set_changed");
    }
    if (result.nonceCalls !== 0) throw new Error("startup_read_used_nonce");
    const item = {
      scenario, command, args: [command], exitCode: result.exitCode,
      stdout: parsedStdout(result), stderr: result.stderr.replaceAll("\r\n", "\n"),
      nonceCalls: result.nonceCalls,
      effects: {
        expectedWrites: [...expectedWrites].sort(), observedWrites,
        documents: observedWrites.map((path) => fileEffect(path, before, after)),
        untouchedEntriesUnchanged: true,
      },
    };
    if (rejection) {
      if (result.exitCode !== 2 || result.stdout !== "") throw new Error("rejection_result_changed");
      item.rejectionImmutability = { treeUnchanged: observedWrites.length === 0 };
    } else {
      if (result.exitCode !== 0 || result.stderr !== "") throw new Error("startup_result_changed");
      const idempotentBefore = await fixture.snapshot();
      const repeated = fixture.run([command]);
      const idempotentAfter = await fixture.snapshot();
      item.idempotence = {
        resultUnchanged: sameResult(result, repeated),
        treeUnchanged: changedPaths(idempotentBefore, idempotentAfter).length === 0,
        nonceCalls: repeated.nonceCalls,
      };
    }
    return item;
  });
}

async function createAccountControls(fixture) {
  const result = fixture.run(["automation-settings-get"]);
  if (result.exitCode !== 0 || result.stderr !== "" || result.nonceCalls !== 0) {
    throw new Error("account_fixture_setup_failed");
  }
}

const CASES = [
  {
    scenario: "settings-missing-controls", command: "automation-settings-get",
    setup: async (fixture) => fixture.omitKnown(ACCOUNT_FILES), expectedWrites: ACCOUNT_FILES,
  },
  {
    scenario: "accounts-missing-controls", command: "employer-account-list",
    setup: async (fixture) => fixture.omitKnown(ACCOUNT_FILES), expectedWrites: ACCOUNT_FILES,
  },
  {
    scenario: "settings-pending-account-journal", command: "automation-settings-get",
    setup: async (fixture) => {
      await createAccountControls(fixture);
      await fixture.seedKnown("account-operation-journal.json", {
        schemaVersion: 1, operation: ACCOUNT_OPERATION,
      });
    },
    expectedWrites: [],
  },
  {
    scenario: "accounts-pending-account-journal", command: "employer-account-list",
    setup: async (fixture) => {
      await createAccountControls(fixture);
      await fixture.seedKnown("account-operation-journal.json", {
        schemaVersion: 1, operation: ACCOUNT_OPERATION,
      });
    },
    expectedWrites: [],
  },
  {
    scenario: "claim-missing-controls", command: "claim-status",
    setup: async (fixture) => fixture.omitKnown(COORDINATOR_FILES),
    expectedWrites: COORDINATOR_FILES,
  },
  {
    scenario: "claim-pending-recovery", command: "claim-status",
    setup: async (fixture) => {
      const created = fixture.run(["claim-status"]);
      if (created.exitCode !== 0 || created.stderr !== "") throw new Error("claim_fixture_setup_failed");
      await fixture.seedKnown("coordinator-journal.json", {
        schemaVersion: 1, operation: RECOVERY_OPERATION,
      });
      await fixture.ageKnown([
        "applications.jsonl", "coordinator-journal.json", "coordinator.json",
      ]);
    },
    expectedWrites: ["applications.jsonl", ...COORDINATOR_FILES],
  },
  {
    scenario: "corrupt-settings-no-write", command: "automation-settings-get",
    setup: async (fixture) => {
      await fixture.omitKnown(ACCOUNT_FILES);
      await fixture.seedKnown("automation-settings.json", `{"private":"${CANARY}"`);
    },
    expectedWrites: [], rejection: true,
  },
  {
    scenario: "future-coordinator-no-write", command: "claim-status",
    setup: async (fixture) => {
      await fixture.omitKnown(COORDINATOR_FILES);
      await fixture.seedKnown("coordinator-journal.json", {
        schemaVersion: 999, operation: { private: CANARY },
      });
    },
    expectedWrites: [], rejection: true,
  },
];

export async function captureStartupReadCorpus() {
  const commands = commandInventory();
  if (commands.length !== 98 || new Set(commands).size !== 98) {
    throw new Error("public_command_inventory_changed");
  }
  const cases = [];
  for (const definition of CASES) cases.push(await captureCase(definition));
  const corpus = {
    schemaVersion: 1, corpus: "python-store-startup-read-v1", source: "python-store-cli",
    fixture: {
      kind: "synthetic-initialized-store-clones", clock: FIXED_CLOCK,
      noncePolicy: "fail-on-use-and-record-zero",
    },
    inventory: { total: 98, commands, captured: CAPTURED, pending: 95 },
    cases,
    redaction: {
      secretCanaryAbsent: !secretCanaryPresent(cases),
      absolutePathsAbsent: !absolutePathPresent(cases),
      checkedSurfaces: ["stdout", "stderr", "fixture-descriptors", "effects", "artifact"],
    },
  };
  if (secretCanaryPresent(cases)) throw new Error("contract_secret_redaction_failed");
  if (absolutePathPresent(cases)) throw new Error("contract_path_redaction_failed");
  if (redactionViolations(corpus)) throw new Error("contract_redaction_failed");
  return JSON.parse(canonicalStartupCorpus(corpus));
}
