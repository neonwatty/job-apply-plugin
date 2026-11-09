import assert from "node:assert/strict";
import test from "node:test";
import {
  typedDeletePhrase, filterTrashItems, trashBlockerText, lifecycleErrorText,
} from "../workspace/lib/helpers.js";

test("trash-reference: delete phrases retain falsy defaults and String coercion", () => {
  for (const value of [undefined, null, false, 0, -0, NaN, ""]) {
    assert.equal(typedDeletePhrase(value), "DELETE ");
  }
  for (const [value, expected] of [
    ["answer", "DELETE ANSWER"], [" resume ", "DELETE  RESUME "],
    ["straße", "DELETE STRASSE"], [true, "DELETE TRUE"],
    [12, "DELETE 12"], [1n, "DELETE 1"], [[], "DELETE "],
    [["job", "answer"], "DELETE JOB,ANSWER"], [{}, "DELETE [OBJECT OBJECT]"],
    [Symbol("synthetic"), "DELETE SYMBOL(SYNTHETIC)"],
    [{ toString: () => "job" }, "DELETE JOB"],
  ]) assert.equal(typedDeletePhrase(value), expected);
  assert.throws(() => typedDeletePhrase(Object.create(null)), TypeError);
});

test("trash-reference: filtering preserves order, item identity and strict type matching", () => {
  const first = Object.freeze({ type: "job", id: "synthetic-1" });
  const second = Object.freeze({ type: "answer", id: "synthetic-2" });
  const third = Object.freeze({ type: "job", id: "synthetic-3" });
  const items = Object.freeze([first, second, third]);
  const filtered = filterTrashItems(items, "job");
  assert.deepEqual(filtered, [first, third]);
  assert.equal(filtered[0], first);
  assert.equal(filtered[1], third);
  assert.notEqual(filtered, items);
  assert.deepEqual(filterTrashItems(items, "Job"), []);
  for (const type of [undefined, "", null, false, 0]) {
    const copy = filterTrashItems(items, type);
    assert.deepEqual(copy, items);
    assert.notEqual(copy, items);
    assert.equal(copy[1], second);
  }
  assert.deepEqual(filterTrashItems([{ type: 1 }, { type: "1" }], 1), [{ type: 1 }]);
  assert.deepEqual(items, [first, second, third]);
});

test("trash-reference: missing collections and malformed elements keep existing behavior", () => {
  for (const value of [undefined, null, false, 0, "", NaN]) {
    assert.deepEqual(filterTrashItems(value), []);
  }
  assert.notEqual(filterTrashItems(null), filterTrashItems(null));
  assert.deepEqual(filterTrashItems([null, undefined, {}, "job"]), [null, undefined, {}, "job"]);
  assert.throws(() => filterTrashItems([null], "job"), TypeError);
  assert.throws(() => filterTrashItems([undefined], "job"), TypeError);
  for (const value of [{}, "job", 1, true]) {
    assert.throws(() => filterTrashItems(value), TypeError);
  }
  assert.deepEqual(filterTrashItems([{}, "job", 1], "job"), []);
  const sparse = [];
  sparse[2] = { type: "job" };
  assert.deepEqual(filterTrashItems(sparse), [{ type: "job" }]);
});

test("trash-reference: blockers sum integers only without clamping negatives", () => {
  for (const item of [undefined, null, false, 0, "", {}, { blockerCounts: null }]) {
    assert.equal(trashBlockerText(item), "No known references");
  }
  for (const [counts, expected] of [
    [{ a: 1 }, "1 protected reference"],
    [{ a: 1, b: 2 }, "3 protected references"],
    [{ a: -2 }, "-2 protected references"],
    [{ a: 2, b: -2 }, "No known references"],
    [{ a: 1, b: 0.5, c: "2", d: true, e: null, f: NaN, g: Infinity, h: 1n }, "1 protected reference"],
    [[1, 2, "4"], "3 protected references"],
    ["123", "No known references"],
    [{ a: Number.MAX_SAFE_INTEGER + 1 }, "9007199254740992 protected references"],
  ]) assert.equal(trashBlockerText({ blockerCounts: counts }), expected);
  const inherited = Object.create({ hidden: 7 });
  inherited.visible = 1;
  assert.equal(trashBlockerText({ blockerCounts: inherited }), "1 protected reference");
});

test("trash-reference: lifecycle messages preserve defaults, coercion and count suffix", () => {
  const fallback = "The lifecycle operation was rejected.";
  for (const error of [undefined, null, false, 0, "", {}, { message: "" }, { message: false }, { message: 0 }]) {
    assert.equal(lifecycleErrorText(error), fallback);
  }
  for (const [error, expected] of [
    [{ message: "Protected history blocks deletion.", counts: { a: 2 } }, "Protected history blocks deletion. (2 protected references.)"],
    [{ counts: { a: 1 } }, `${fallback} (1 protected reference.)`],
    [{ message: 12 }, "12"],
    [{ message: {} }, "[object Object]"],
    [{ message: "Denied", counts: { a: -1 } }, "Denied (-1 protected references.)"],
    [{ message: "Denied", counts: { a: 1, b: -1 } }, "Denied"],
    [{ message: "Denied", counts: { a: 1, b: 0.5, c: "2", d: true, e: NaN, f: Infinity } }, "Denied (1 protected reference.)"],
  ]) assert.equal(lifecycleErrorText(error), expected);
  assert.throws(() => lifecycleErrorText({ message: Symbol("synthetic") }), TypeError);
});

test("trash-reference: revision conflict takes precedence without consulting other fields", () => {
  const error = Object.freeze({
    code: "revision_conflict",
    get counts() { throw new Error("must not read counts"); },
    get message() { throw new Error("must not read message"); },
  });
  assert.equal(lifecycleErrorText(error),
    "This record changed elsewhere. Nothing was retried; refresh Trash and review the latest revision.");
  assert.equal(lifecycleErrorText({ code: "REVISION_CONFLICT", message: "ordinary" }), "ordinary");
});

test("trash-reference: presentation functions leave frozen caller records unchanged", () => {
  const counts = Object.freeze({ sessions: 1, claims: 2 });
  const item = Object.freeze({ type: "answer", blockerCounts: counts });
  const error = Object.freeze({ code: "protected", message: "Denied", counts });
  const before = structuredClone({ item, error });
  typedDeletePhrase(item.type);
  filterTrashItems(Object.freeze([item]), "answer");
  trashBlockerText(item);
  lifecycleErrorText(error);
  assert.deepEqual({ item, error }, before);
});
