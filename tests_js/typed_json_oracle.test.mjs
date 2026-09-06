import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parsePythonJson, PythonJsonError } from "../runtime/contracts/raw-json/parser.js";
import { serializePythonScope } from "../runtime/contracts/raw-json/serializer.js";

const reference = fileURLToPath(new URL("../tools/contracts/typed-json/reference.py", import.meta.url));
const mandatory = process.platform === "win32" ? "python" : "python3";
const profiles = new Set();

function capture(executable, args = [], input = "") {
  return spawnSync(executable, ["-I", reference, ...args], {
    input, encoding: "utf8", timeout: 25_000, maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

for (const executable of [mandatory, "python3.12", "python3.13", "python3.14"]) {
  test(`typed JSON independently matches ${executable} reference`, (t) => {
    const observed = capture(executable);
    if (observed.error?.code === "ENOENT" && executable !== mandatory) {
      t.skip(`${executable} executable unavailable; no profile parity inferred`);
      return;
    }
    assert.ifError(observed.error);
    assert.equal(observed.status, 0, observed.stderr);
    assert.equal(observed.stderr, "");
    const repeated = capture(executable);
    assert.ifError(repeated.error);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.stdout, observed.stdout, "fixed corpus must reproduce byte-for-byte");
    const corpus = JSON.parse(observed.stdout);
    assert.equal(corpus.provenance.implementation, "cpython");
    assert.equal(corpus.provenance.inputModel, "unicode-scalar-raw-text");
    assert.match(corpus.provenance.python, /^3\.\d+\.\d+/);
    assert.equal(corpus.seed, 0x71a9b003);
    assert.equal(corpus.randomCases, 512);
    assert.equal(corpus.stringCases, 128);
    assert.equal(corpus.cases.length, 712);
    const profile = JSON.stringify(corpus.provenance);
    t.diagnostic(JSON.stringify({ ...corpus.provenance, cases: corpus.cases.length,
      seed: corpus.seed, repeatedProfile: profiles.has(profile) }));
    profiles.add(profile);
    for (const expected of corpus.cases) {
      // Reject an invalid transport fixture instead of silently replacing surrogates.
      assert.equal(Buffer.from(expected.raw, "utf8").toString("utf8"), expected.raw, expected.id);
      // The request reaches the TS parser as original text, never decoded/re-encoded.
      const decode = () => parsePythonJson(expected.raw, { intMaxStrDigits: corpus.provenance.intMaxStrDigits });
      if (expected.accepted) {
        assert.equal(serializePythonScope(decode()), expected.scope, expected.id);
      } else {
        assert.throws(decode, (error) => {
          assert.ok(error instanceof PythonJsonError, expected.id);
          assert.equal(error.reason, "syntax", expected.id);
          return true;
        });
      }
    }
  });

  test(`${executable} typed reference rejects caller arguments and stdin`, (t) => {
    for (const [args, input] of [[ ["--input", "/synthetic/unavailable"], "" ], [ [], "{}" ]]) {
      const result = capture(executable, args, input);
      if (result.error?.code === "ENOENT" && executable !== mandatory) {
        t.skip(`${executable} executable unavailable`);
        return;
      }
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "reference_input_rejected\n");
    }
  });
}
