import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { captureStartupReadCorpus } from "../tools/contracts/capture-startup-read-corpus.mjs";
import { withOwnedStoreFixture } from "../tools/contracts/owned-store-fixture.mjs";
import {
  canonicalStartupCorpus, validateStartupCorpus,
} from "../tools/contracts/startup-vector-format.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(
  REPO_ROOT, "test", "contract", "vectors", "python-store-startup-read-v1.json",
);
const CAPTURE = join(REPO_ROOT, "tools", "capture-python-contracts.mjs");
const VERIFY = join(REPO_ROOT, "tools", "verify-contract-redaction.mjs");
const SCHEMA = join(REPO_ROOT, "contracts", "cli", "python-startup-read-corpus.schema.json");

async function goldenCorpus() {
  return JSON.parse(await readFile(GOLDEN, "utf8"));
}

test("fresh disposable startup-read capture equals the reviewed golden", async () => {
  const golden = await goldenCorpus();
  assert.equal(
    canonicalStartupCorpus(await captureStartupReadCorpus()),
    canonicalStartupCorpus(golden),
  );
  assert.deepEqual(golden.inventory.captured, [
    "automation-settings-get", "employer-account-list", "claim-status",
  ]);
  assert.equal(golden.cases.length, 8);
  assert.equal(golden.cases.every((item) => item.nonceCalls === 0), true);
});

test("golden distinguishes account journal preservation from coordinator recovery", async () => {
  const cases = new Map((await goldenCorpus()).cases.map((item) => [item.scenario, item]));
  for (const scenario of [
    "settings-pending-account-journal", "accounts-pending-account-journal",
  ]) {
    assert.deepEqual(cases.get(scenario).effects.observedWrites, []);
    assert.equal(cases.get(scenario).idempotence.treeUnchanged, true);
  }
  const recovery = cases.get("claim-pending-recovery");
  assert.deepEqual(recovery.effects.observedWrites, [
    "applications.jsonl", "coordinator-journal.json", "coordinator.json",
  ]);
  assert.equal(recovery.stdout.claim.expired, false);
  assert.equal(Object.hasOwn(recovery.stdout.claim, "tokenHash"), false);
  assert.equal(recovery.idempotence.resultUnchanged, true);
});

test("bootstrap writes are private, exact, and leave every other entry untouched", async () => {
  const cases = (await goldenCorpus()).cases.filter((item) => (
    item.scenario.endsWith("missing-controls")
  ));
  assert.equal(cases.length, 3);
  for (const item of cases) {
    assert.deepEqual(item.effects.expectedWrites, item.effects.observedWrites);
    assert.equal(item.effects.untouchedEntriesUnchanged, true);
    assert.equal(item.effects.documents.every((document) => (
      document.before === null && document.after.modeContract === "private-file-0600-posix"
        && document.after.size > 0 && document.mtimeChanged === true
    )), true);
    assert.equal(item.idempotence.treeUnchanged, true);
  }
});

test("corrupt and future controls reject before creating missing siblings", async () => {
  const rejected = (await goldenCorpus()).cases.filter((item) => item.exitCode === 2);
  assert.deepEqual(rejected.map((item) => item.scenario), [
    "corrupt-settings-no-write", "future-coordinator-no-write",
  ]);
  for (const item of rejected) {
    assert.deepEqual(item.effects.expectedWrites, []);
    assert.deepEqual(item.effects.observedWrites, []);
    assert.equal(item.rejectionImmutability.treeUnchanged, true);
    assert.doesNotMatch(item.stderr, /contract_secret_canary|job-apply-startup-contracts|\/tmp\//i);
  }
});

test("startup runtime validator fails closed on effect and immutability weakening", async () => {
  const golden = await goldenCorpus();
  const unknown = structuredClone(golden);
  unknown.cases[0].effects.unreviewed = true;
  assert.throws(() => validateStartupCorpus(unknown), /effects_unknown_field/);
  const omittedWrite = structuredClone(golden);
  omittedWrite.cases[0].effects.observedWrites.pop();
  assert.throws(() => validateStartupCorpus(omittedWrite), /effects_invalid/);
  const renamedScenario = structuredClone(golden);
  renamedScenario.cases[0].scenario = "unreviewed";
  assert.throws(() => validateStartupCorpus(renamedScenario), /case_identity_invalid/);
  const mutableUntouched = structuredClone(golden);
  mutableUntouched.cases[0].effects.untouchedEntriesUnchanged = "yes";
  assert.throws(() => validateStartupCorpus(mutableUntouched), /effects_invalid/);
  const nonce = structuredClone(golden);
  nonce.cases[0].idempotence.nonceCalls = 1;
  assert.throws(() => validateStartupCorpus(nonce), /idempotence_invalid/);
  const mutableRejection = structuredClone(golden);
  mutableRejection.cases.at(-1).rejectionImmutability.treeUnchanged = false;
  assert.throws(() => validateStartupCorpus(mutableRejection), /rejection_immutability_invalid/);
  const malformedDigest = structuredClone(golden);
  malformedDigest.cases[0].effects.documents[0].after.digest = "not-a-digest";
  assert.throws(() => validateStartupCorpus(malformedDigest), /effect_after_invalid/);
});

test("strict JSON Schema and runtime both reject every known parity weakness", async () => {
  const golden = await goldenCorpus();
  const schema = JSON.parse(await readFile(SCHEMA, "utf8"));
  const validateSchema = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validateSchema(golden), true, JSON.stringify(validateSchema.errors));
  const mutations = [
    (value) => { value.cases[0].stderr = "unexpected"; },
    (value) => { value.cases.at(-1).stdout = {}; },
    (value) => { value.cases[0].effects.documents = []; },
    (value) => { value.cases[0].effects.documents[0].path = "coordinator.json"; },
    (value) => {
      value.cases[0].effects.documents[0].before = null;
      value.cases[0].effects.documents[0].after = null;
    },
    (value) => {
      const index = value.inventory.commands.indexOf("automation-settings-get");
      value.inventory.commands[index] = "unreviewed-command";
    },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(golden);
    mutate(candidate);
    assert.equal(validateSchema(candidate), false);
    assert.throws(() => validateStartupCorpus(candidate));
  }
});

test("owned fixtures expose no caller root and reject unknown document authority", async () => {
  await withOwnedStoreFixture("authority", async (fixture) => {
    assert.deepEqual(Object.keys(fixture).sort(), [
      "ageKnown", "omitKnown", "run", "seedKnown", "snapshot",
    ]);
    await assert.rejects(
      fixture.seedKnown("../profile.json", "{}"), /fixture_document_forbidden/,
    );
    await assert.rejects(
      fixture.omitKnown(["profile.json"]), /fixture_document_forbidden/,
    );
    assert.throws(() => fixture.run(["profile-inspect"]), /fixture_command_invalid/);
    assert.throws(() => fixture.run([
      "automation-settings-get", "--input", "/private/caller.json",
    ]), /fixture_command_invalid/);
    assert.equal(fixture.run(["claim-status"]).exitCode, 0);
    assert.equal((await fixture.snapshot()).some((entry) => entry.kind === "directory"), true);
  });
  await assert.rejects(
    withOwnedStoreFixture("../escape", async () => {}), /fixture_label_invalid/,
  );
});

test("startup capture CLI refuses live roots, repository output, and ambient Store", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "startup-contract-cli-test-"));
  try {
    const callerRoot = join(temporary, "caller-store");
    const invalid = spawnSync(process.execPath, [
      CAPTURE, "--corpus", "startup-read", "--root", callerRoot,
    ], { encoding: "utf8" });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stderr, '{"ok":false,"error":"invalid_invocation"}\n');
    const repository = spawnSync(process.execPath, [
      CAPTURE, "--corpus", "startup-read", "--output", GOLDEN,
    ], { encoding: "utf8" });
    assert.equal(repository.status, 2);
    assert.equal(repository.stderr, '{"ok":false,"error":"repository_output_forbidden"}\n');
    const home = join(temporary, "home");
    const output = join(temporary, "candidate.json");
    await mkdir(home);
    await writeFile(join(home, ".claude-job-profile.json"), '{"secret":"AMBIENT"}\n');
    const captured = spawnSync(process.execPath, [
      CAPTURE, "--corpus", "startup-read", "--output", output,
    ], {
      encoding: "utf8", env: { ...process.env, HOME: home, JOB_APPLY_STORE_DIR: callerRoot },
    });
    assert.equal(captured.status, 0, captured.stderr);
    assert.equal(await readFile(output, "utf8"), canonicalStartupCorpus(await goldenCorpus()));
    assert.equal(await access(callerRoot).then(() => true, () => false), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("redaction verifier accepts both corpora and rejects startup poison generically", async () => {
  const readGolden = join(REPO_ROOT, "test", "contract", "vectors", "python-store-read-v1.json");
  const accepted = spawnSync(process.execPath, [VERIFY, readGolden, GOLDEN], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, '{"ok":true,"checked":2}\n');
  const temporary = await mkdtemp(join(tmpdir(), "startup-contract-redaction-test-"));
  try {
    const poisoned = structuredClone(await goldenCorpus());
    poisoned.cases[0].stdout = { path: "/private/alice/store.json" };
    const path = join(temporary, "poisoned.json");
    await writeFile(path, JSON.stringify(poisoned));
    const rejected = spawnSync(process.execPath, [VERIFY, path], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stderr, '{"ok":false,"error":"contract_redaction_failed"}\n');
    assert.doesNotMatch(rejected.stderr, /private|alice|poisoned|\/tmp\//i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
