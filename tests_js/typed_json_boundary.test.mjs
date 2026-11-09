import assert from "node:assert/strict";
import test from "node:test";
import { NumericAtomError } from "../runtime/contracts/raw-json/numeric-atom.js";
import { parsePythonJson, PythonJsonError } from "../runtime/contracts/raw-json/parser.js";
import { serializePythonScope } from "../runtime/contracts/raw-json/serializer.js";

const options = { intMaxStrDigits: 4300 };
const parse = (raw) => parsePythonJson(raw, options);

test("typed objects preserve numeric identity, duplicate decoded keys and safe property names", () => {
  const parsed = parse('{"a":1,"\\u0061":1.0,"__proto__":-0,"constructor":-0.0,"array":[true,false,null]}');
  assert.ok(parsed instanceof Map);
  assert.equal(parsed.size, 4);
  assert.equal(parsed.get("a").kind, "float");
  assert.equal(parsed.get("__proto__").value, 0n);
  assert.equal(Object.is(parsed.get("constructor").value, -0), true);
  assert.deepEqual(parsed.get("array"), [true, false, null]);
  assert.equal(serializePythonScope(parsed), '{"__proto__":0,"a":1.0,"array":[true,false,null],"constructor":-0.0}');
});

test("Python key sorting uses Unicode code points and strings remain ensure-ASCII", () => {
  const raw = '{"𐀀":"😀","":"é","2":"\\ud800","12":"\\udfff","0":"\\u0000"}';
  assert.equal(serializePythonScope(parse(raw)), '{"0":"\\u0000","12":"\\udfff","2":"\\ud800","\\ue000":"\\u00e9","\\ud800\\udc00":"\\ud83d\\ude00"}');
});

test("UTF-8 raw text retains lone escaped keys and combines escaped surrogate pairs", () => {
  // This models scalar raw transport text, not arbitrary non-UTF-8 Python strings.
  const raw = '{"\\ud800\\udc00":1,"\\ud800":2,"\\ue000":3,"\\udfff":4}';
  assert.equal(Buffer.from(raw, "utf8").toString("utf8"), raw);
  assert.equal(serializePythonScope(parse(raw)), '{"\\ud800":2,"\\udfff":4,"\\ue000":3,"\\ud800\\udc00":1}');
});

test("non-finite values and numeric overflow retain Python spellings", () => {
  assert.equal(serializePythonScope(parse('[NaN,Infinity,-Infinity,1e9999,-1e-9999,1e0,9007199254740993]')),
    '[NaN,Infinity,-Infinity,Infinity,-0.0,1.0,9007199254740993]');
});

test("syntax error offsets count code points rather than UTF-16 units", () => {
  for (const [raw, offset] of [['["😀",?]', 5], ['{"😀":?}', 5], ['"😀" x', 4]]) {
    assert.throws(() => parse(raw), (error) => {
      assert.ok(error instanceof PythonJsonError);
      assert.equal(error.reason, "syntax");
      assert.equal(error.offset, offset);
      return true;
    });
  }
});

test("integer digit limits apply inside documents without restricting unlimited mode", () => {
  const integer = "9".repeat(4301);
  assert.throws(() => parse(`[${integer}]`), (error) => error instanceof NumericAtomError && error.reason === "integer-digit-limit");
  assert.equal(serializePythonScope(parsePythonJson(`[${integer}]`, { intMaxStrDigits: 0 })), `[${integer}]`);
});

test("deep parsing and serialization have no diagnostic depth cap", () => {
  // This is a TS capability check, not Python caller recursion equivalence evidence.
  const raw = "[".repeat(2000) + "null" + "]".repeat(2000);
  assert.equal(serializePythonScope(parse(raw)), raw);
});

test("serializer rejects cycles while allowing shared acyclic values", () => {
  const child = new Map([["a", true]]);
  assert.equal(serializePythonScope([child, child]), '[{"a":true},{"a":true}]');
  const cyclic = [];
  cyclic.push(cyclic);
  assert.throws(() => serializePythonScope(cyclic));
  const cyclicMap = new Map();
  cyclicMap.set("cycle", cyclicMap);
  assert.throws(() => serializePythonScope(cyclicMap));
});
