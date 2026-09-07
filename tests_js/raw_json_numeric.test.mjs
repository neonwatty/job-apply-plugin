import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  NumericAtomError,
  parseNumericAtom,
} from "../runtime/contracts/raw-json/numeric-atom.js";

const reference = fileURLToPath(new URL("../tools/contracts/raw-json-numeric/reference.py", import.meta.url));
const options = { intMaxStrDigits: 4300 };
const defaultInterpreter = process.platform === "win32" ? "python" : "python3";
const interpreters = [defaultInterpreter, "python3.12", "python3.13", "python3.14"];
const observedProfiles = new Set();

function runReference(executable, args = [], input = "") {
  return spawnSync(executable, ["-I", reference, ...args], {
    input,
    encoding: "utf8",
    timeout: 25_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

function bits(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  return buffer.toString("hex");
}

function rejectsToken(token, reason, configuration = options) {
  assert.throws(() => parseNumericAtom(token, configuration), (error) => {
    assert.ok(error instanceof NumericAtomError);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("single numeric token grammar rejects whitespace, junk and alternate spellings", () => {
  for (const token of [
    "", " ", " 1", "1 ", "\n1", "1\n", "+1", "01", "-01", ".1", "1.",
    "1e", "1e+", "1e-", "--1", "0x1", "1_000", "1,2", "[]", "{}",
    "true", "null", "nan", "inf", "+Infinity", "-NaN", "1\u0000", "１",
  ]) rejectsToken(token, "syntax");
});

test("integer identity, digit limits and signed zero are exact", () => {
  assert.deepEqual(parseNumericAtom("-0", options), { kind: "int", value: 0n, scope: "0" });
  for (const token of ["0.0", "-0.0", "-0e0", "1.0", "1e0"]) {
    const atom = parseNumericAtom(token, options);
    assert.equal(atom.kind, "float");
    assert.equal(Object.is(atom.value, -0), token.startsWith("-"));
  }
  const accepted = "9".repeat(4300);
  assert.equal(parseNumericAtom(accepted, options).scope, accepted);
  assert.equal(parseNumericAtom(`-${accepted}`, options).scope, `-${accepted}`);
  rejectsToken("9".repeat(4301), "integer-digit-limit");
  rejectsToken(`-${"9".repeat(4301)}`, "integer-digit-limit");
  const unlimited = "9".repeat(5000);
  assert.equal(parseNumericAtom(unlimited, { intMaxStrDigits: 0 }).scope, unlimited);
  assert.equal(parseNumericAtom(`${accepted}.0`, options).scope, "Infinity");
});

test("fixed finite scope formatting remains required without versioned executables", () => {
  for (const [token, scope] of [
    ["1e0", "1.0"],
    ["-0e100", "-0.0"],
    ["1e-4", "0.0001"],
    ["1e-5", "1e-05"],
    ["1e15", "1000000000000000.0"],
    ["1e16", "1e+16"],
    ["9007199254740993.0", "9007199254740992.0"],
    ["5e-324", "5e-324"],
    ["2e-324", "0.0"],
    ["-1e-999999", "-0.0"],
    ["1.7976931348623157e308", "1.7976931348623157e+308"],
    ["1.00000000000000011102230246251565404236316680908203125", "1.0"],
  ]) {
    const atom = parseNumericAtom(token, options);
    assert.equal(atom.kind, "float", token);
    assert.equal(atom.scope, scope, token);
  }
});

test("integer digit configuration rejects invalid limits", () => {
  for (const intMaxStrDigits of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "4300", null]) {
    assert.throws(() => parseNumericAtom("1", { intMaxStrDigits }), RangeError);
  }
});

function verifyNumeric(executable, t) {
    const result = runReference(executable);
    if (result.error?.code === "ENOENT" && executable !== defaultInterpreter) {
      t.skip(`${executable} executable unavailable; version parity not established by this alias`);
      return;
    }
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const repeated = runReference(executable);
    assert.ifError(repeated.error);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.stdout, result.stdout, "fixed synthetic capture must be deterministic");
    assert.equal(repeated.stderr, "");
    const corpus = JSON.parse(result.stdout);
    assert.equal(corpus.provenance.implementation, "cpython");
    assert.match(corpus.provenance.python, /^3\.\d+\.\d+(?:[a-z0-9.+-]*)$/);
    assert.match(corpus.provenance.unicode, /^\d+\.\d+\.\d+$/);
    assert.equal(corpus.seed, 0x5a17c0de);
    assert.equal(corpus.binary64Samples, 4096);
    assert.equal(corpus.decimalVariants, 1024);
    assert.ok(corpus.cases.length >= 5700);
    const profile = JSON.stringify(corpus.provenance);
    t.diagnostic(JSON.stringify({
      ...corpus.provenance,
      seed: corpus.seed,
      cases: corpus.cases.length,
      repeatedProfile: observedProfiles.has(profile),
    }));
    // Multiple executable aliases for one profile do not add independent evidence.
    observedProfiles.add(profile);
    for (const expected of corpus.cases) {
      const actual = parseNumericAtom(expected.token, options);
      assert.equal(actual.kind, expected.kind, expected.token);
      assert.equal(actual.scope, expected.scope, expected.token);
      if (actual.kind === "int") {
        assert.equal(actual.value, BigInt(expected.scope), expected.token);
      } else if (Number.isNaN(actual.value)) {
        assert.equal(expected.scope, "NaN", expected.token);
      } else {
        assert.equal(bits(actual.value), expected.bits, expected.token);
      }
    }
}

function verifyNumericRejection(executable, t) {
    for (const [args, input] of [[ ["--input", "arbitrary"], "" ], [ [], "1" ]]) {
      const result = runReference(executable, args, input);
      if (result.error?.code === "ENOENT" && executable !== defaultInterpreter) {
        t.skip(`${executable} executable unavailable`);
        return;
      }
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "reference_input_rejected\n");
    }
}

if (process.platform === 'win32') {
  test('independent numeric oracle from python', t => verifyNumeric(defaultInterpreter, t));
} else {
  test('independent numeric oracle from python3', t => verifyNumeric(defaultInterpreter, t));
}
if (process.platform === 'win32') {
  test('python reference rejects caller arguments and stdin', t => verifyNumericRejection(defaultInterpreter, t));
} else {
  test('python3 reference rejects caller arguments and stdin', t => verifyNumericRejection(defaultInterpreter, t));
}
test('independent numeric oracle from python3.12', t => verifyNumeric('python3.12', t));
test('python3.12 reference rejects caller arguments and stdin', t => verifyNumericRejection('python3.12', t));
test('independent numeric oracle from python3.13', t => verifyNumeric('python3.13', t));
test('python3.13 reference rejects caller arguments and stdin', t => verifyNumericRejection('python3.13', t));
test('independent numeric oracle from python3.14', t => verifyNumeric('python3.14', t));
test('python3.14 reference rejects caller arguments and stdin', t => verifyNumericRejection('python3.14', t));
