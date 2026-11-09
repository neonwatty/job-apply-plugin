import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalCorpus, captureCorpus, validateCorpus } from "../tools/contracts/profile-facts/capture.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(REPO, "test/contract/vectors/python-profile-fact-mutations-v1.json");
const CAPTURE = join(REPO, "tools/contracts/profile-facts/capture.mjs");
const CANARY = "PROFILE_FACT_SECRET_CANARY_7c923d";
const golden = async () => JSON.parse(await readFile(GOLDEN, "utf8"));
function cli(args) {
  return spawnSync(process.execPath, [CAPTURE, ...args], { encoding: "utf8", timeout: 30_000 });
}

test("two fresh captures exactly equal the reviewed reference, including persisted bytes", async () => {
  const expected = canonicalCorpus(await golden());
  assert.equal(canonicalCorpus(await captureCorpus()), expected);
  assert.equal(canonicalCorpus(await captureCorpus()), expected);
});

test("slice freezes revisions, provenance, pointer escaping, deletion and no-ops", async () => {
  const cases = new Map((await golden()).cases.map((c) => [c.scenario, c]));
  const merge = JSON.parse(cases.get("profile-merge").stdout);
  assert.equal(merge.revision, 2);
  assert.equal(merge.factProvenance["/identity/name"].source, "user");
  assert.equal(JSON.parse(cases.get("profile-nested-delete").stdout).revision, 3);
  assert.equal(JSON.parse(cases.get("profile-pointer-escaping").stdout).factProvenance["/a~1b~0c"].source, "user");
  assert.equal(JSON.parse(cases.get("group-create").stdout).label, "Identity");
  assert.equal(JSON.parse(cases.get("group-update").stdout).revision, 2);
  assert.equal(JSON.parse(cases.get("group-delete").stdout).deleted, true);
  for (const item of cases.values()) {
    assert.deepEqual(item.expectedWrites, item.observedWrites);
    if (item.exitCode !== 0 || item.scenario.endsWith("noop")) assert.deepEqual(item.effects, []);
    if (item.exitCode !== 0) assert.equal(item.rejectedStateUnchanged, true);
    for (const effect of item.effects) {
      assert.equal(effect.mtimeChanged, true);
      assert.notEqual(effect.before, effect.after);
      assert.equal(effect.modeContract, "0600-on-posix-unverified-on-windows");
    }
  }
});

test("closed schema rejects extra fields at every contract envelope", async () => {
  for (const mutate of [
    (v) => { v.extra = true; },
    (v) => { v.cases[0].extra = true; },
    (v) => { v.cases[0].effects[0].extra = true; },
    (v) => { v.cases[0].input.extra = true; },
    (v) => { v.cases[0].observedWrites = []; },
    (v) => { v.cases.pop(); },
    (v) => { v.cases[0].uuidCalls = 1; },
    (v) => { v.cases[0].effects[0].mtimeChanged = false; },
  ]) {
    const value = await golden();
    mutate(value);
    assert.throws(() => validateCorpus(value), /profile_fact_/);
  }
});

test("redaction rejects canaries in every string output surface without echoing them", async () => {
  for (const mutate of [
    (v) => { v.cases[0].stdout += CANARY; },
    (v) => { v.cases[0].stderr += CANARY; },
    (v) => { v.cases[0].effects[0].after += CANARY; },
    (v) => { v.cases[0].effects[0].before += CANARY; },
    (v) => { v.cases[0].input = CANARY; },
    (v) => { v.cases[0].stdout = "/Users/synthetic/private"; },
  ]) {
    const value = await golden();
    mutate(value);
    assert.throws(() => validateCorpus(value), (error) => !error.message.includes(CANARY)
      && /^profile_fact_/.test(error.message));
  }
});

test("capture cannot refresh goldens, follow repository directory aliases or accept Store roots", async () => {
  const original = await readFile(GOLDEN);
  const temporary = await mkdtemp(join(tmpdir(), "profile-fact-output-test-"));
  try {
    const destination = join(temporary, "candidate.json");
    await writeFile(destination, "preserve");
    for (const args of [
      ["--output", GOLDEN], ["--output", destination],
      ["--root", temporary, "--output", join(temporary, "other.json")],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.includes(temporary), false);
    }
    const alias = join(temporary, "repository-alias");
    await symlink(REPO, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(cli(["--output", resolve(alias, "forbidden-candidate.json")]).status, 2);
    assert.equal(await readFile(destination, "utf8"), "preserve");
    assert.deepEqual(await readFile(GOLDEN), original);
    const fresh = join(temporary, "fresh.json");
    assert.equal(cli(["--output", fresh]).status, 0);
    assert.equal(await readFile(fresh, "utf8"), canonicalCorpus(await golden()));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Python fixture refuses caller arguments before touching any Store", () => {
  const result = spawnSync(process.env.PYTHON || "python3", ["-I",
    join(REPO, "tools/contracts/profile-facts/driver.py"), "--root", "forbidden"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /fixture_arguments_forbidden/);
});
