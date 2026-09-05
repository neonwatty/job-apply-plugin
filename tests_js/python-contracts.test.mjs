import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { captureReadCorpus } from "../tools/contracts/capture-read-corpus.mjs";
import { commandInventory } from "../tools/contracts/python-store.mjs";
import {
  absolutePathPresent, canonicalCorpus, validateCorpus,
} from "../tools/contracts/vector-format.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(REPO_ROOT, "test", "contract", "vectors", "python-store-read-v1.json");
const CAPTURE = join(REPO_ROOT, "tools", "capture-python-contracts.mjs");
const VERIFY = join(REPO_ROOT, "tools", "verify-contract-redaction.mjs");

async function goldenCorpus() {
  return JSON.parse(await readFile(GOLDEN, "utf8"));
}

test("actual Store parser has the exact frozen 98-command inventory", async () => {
  const golden = await goldenCorpus();
  const commands = commandInventory();
  assert.equal(commands.length, 98);
  assert.equal(new Set(commands).size, 98);
  assert.deepEqual(commands, golden.inventory.commands);
});

test("fresh isolated Python read capture equals the reviewed golden", async () => {
  const golden = await goldenCorpus();
  assert.equal(canonicalCorpus(await captureReadCorpus()), canonicalCorpus(golden));
  assert.equal(golden.inventory.captured.length, 9);
  assert.equal(golden.inventory.pending, 89);
  assert.equal(golden.cases.every((item) => item.storeUnchanged), true);
  const rejected = golden.cases.filter((item) => item.exitCode === 2);
  assert.deepEqual(rejected.map((item) => item.scenario), ["corrupt-profile", "future-profile"]);
  assert.equal(rejected.every((item) => (
    item.rejectionImmutability.bytesUnchanged && item.rejectionImmutability.mtimeNsUnchanged
  )), true);
});

test("capture refuses caller roots, repository goldens, and overwrites", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "contract-cli-test-"));
  try {
    const callerRoot = spawnSync(process.execPath, [CAPTURE, "--root", temporary], { encoding: "utf8" });
    assert.equal(callerRoot.status, 2);
    assert.equal(callerRoot.stderr, '{"ok":false,"error":"invalid_invocation"}\n');
    const repositoryOutput = spawnSync(process.execPath, [CAPTURE, "--output", GOLDEN], { encoding: "utf8" });
    assert.equal(repositoryOutput.status, 2);
    assert.equal(repositoryOutput.stderr, '{"ok":false,"error":"repository_output_forbidden"}\n');
    const output = join(temporary, "existing.json");
    await writeFile(output, "preserve-me", { mode: 0o600 });
    const overwrite = spawnSync(process.execPath, [CAPTURE, "--output", output], { encoding: "utf8" });
    assert.equal(overwrite.status, 2);
    assert.equal(overwrite.stderr, '{"ok":false,"error":"capture_failed"}\n');
    assert.equal(await readFile(output, "utf8"), "preserve-me");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("capture ignores ambient Store and legacy-profile locations", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "contract-environment-test-"));
  try {
    const home = join(temporary, "home");
    const output = join(temporary, "captured.json");
    const callerStore = join(temporary, "caller-store");
    await mkdir(home);
    const legacy = join(home, ".claude-job-profile.json");
    await writeFile(legacy, '{"secret":"CONTRACT_SECRET_CANARY_AMBIENT"}\n');
    const result = spawnSync(process.execPath, [CAPTURE, "--output", output], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        JOB_APPLY_STORE_DIR: callerStore,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, "utf8"), canonicalCorpus(await goldenCorpus()));
    assert.equal(await access(callerStore).then(() => true, () => false), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("runtime validator rejects unknown fields and non-finite values", async () => {
  const golden = await goldenCorpus();
  const unknown = structuredClone(golden);
  unknown.unreviewed = true;
  assert.throws(() => validateCorpus(unknown), /corpus_unknown_field/);
  const missing = structuredClone(golden);
  delete missing.cases[0].scenario;
  assert.throws(() => validateCorpus(missing), /case_required_field/);
  const duplicate = structuredClone(golden);
  duplicate.inventory.captured[1] = duplicate.inventory.captured[0];
  assert.throws(() => validateCorpus(duplicate), /captured_commands_invalid/);
  const malformedInventory = structuredClone(golden);
  malformedInventory.inventory.commands[malformedInventory.inventory.commands.length - 1] = null;
  assert.throws(() => validateCorpus(malformedInventory), /inventory_commands_invalid/);
  const mutableRejection = structuredClone(golden);
  mutableRejection.cases.at(-1).storeUnchanged = false;
  assert.throws(() => validateCorpus(mutableRejection), /rejection_case_invalid/);
  const truthyRejection = structuredClone(golden);
  truthyRejection.cases.at(-1).rejectionImmutability.bytesUnchanged = "yes";
  truthyRejection.cases.at(-1).rejectionImmutability.mtimeNsUnchanged = "yes";
  assert.throws(() => validateCorpus(truthyRejection), /rejection_case_invalid/);
  const nonFinite = structuredClone(golden);
  nonFinite.cases[0].stdout = Number.NaN;
  assert.throws(() => validateCorpus(nonFinite), /stdout_non_finite/);
  assert.equal(absolutePathPresent({ value: "/var/private/data.json" }), true);
  assert.equal(absolutePathPresent({ value: "/data/alice/profile.json" }), true);
  assert.equal(absolutePathPresent({ value: "C:\\Users\\private\\data.json" }), true);
  assert.equal(absolutePathPresent({ value: "D:\\secrets\\profile.json" }), true);
  assert.equal(absolutePathPresent({ value: "C:/profiles/alice.json" }), true);
  assert.equal(absolutePathPresent({ value: "\\\\server\\private\\data.json" }), true);
  assert.equal(absolutePathPresent({ paths: ["/phone", "/firstName"] }), false);
  assert.equal(absolutePathPresent({ paths: ["/data/alice/profile.json"] }), true);
  assert.equal(absolutePathPresent(JSON.stringify({ paths: ["/data/alice/profile.json"] })), true);
});

test("redaction verification is fail-closed and never repeats the canary or path", async () => {
  const accepted = spawnSync(process.execPath, [VERIFY, GOLDEN], { encoding: "utf8" });
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdout, '{"ok":true,"checked":1}\n');
  const temporary = await mkdtemp(join(tmpdir(), "contract-redaction-test-"));
  try {
    const poisoned = join(temporary, "poisoned.json");
    await writeFile(poisoned, '{"value":"CONTRACT_SECRET_CANARY_NEVER_ECHO"}\n', { mode: 0o600 });
    const rejected = spawnSync(process.execPath, [VERIFY, poisoned], { encoding: "utf8" });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr, '{"ok":false,"error":"contract_redaction_failed"}\n');
    assert.doesNotMatch(rejected.stderr, /canary|poisoned|contract-redaction-test|\/tmp\//i);
    for (const [name, stdout] of [
      ["direct.json", { paths: ["/data/alice/profile.json"] }],
      ["nested.json", { payload: JSON.stringify({ paths: ["/data/alice/profile.json"] }) }],
    ]) {
      const corpus = structuredClone(await goldenCorpus());
      corpus.cases[0].stdout = stdout;
      const path = join(temporary, name);
      await writeFile(path, JSON.stringify(corpus));
      const pathRejected = spawnSync(process.execPath, [VERIFY, path], { encoding: "utf8" });
      assert.equal(pathRejected.status, 1);
      assert.equal(pathRejected.stderr, '{"ok":false,"error":"contract_redaction_failed"}\n');
      assert.doesNotMatch(pathRejected.stderr, /data|alice|profile|direct|nested|\/tmp\//i);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
