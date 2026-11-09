import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBudget, MAX_EVENTS } from "../qa/recorder/event-budget.mjs";

test("event flood admits exactly eight inspections until work completes", () => {
  const budget = createEventBudget();
  const admissions = Array.from({ length: 200 }, () => budget.reserveInspection());
  assert.equal(admissions.filter(Boolean).length, 8);
  budget.releaseInspection(); // Rejected or failed inspection releases its slot.
  assert.equal(budget.reserveInspection(), true);
  assert.equal(budget.reserveInspection(), false);
});

test("pending writes retain slots and share the inspection budget", () => {
  const budget = createEventBudget();
  for (let index = 0; index < 8; index += 1) {
    assert.equal(budget.reserveInspection(), true);
    if (index < 4) {
      budget.beginWrite();
      budget.releaseInspection();
    }
  }
  assert.equal(budget.reserveInspection(), false);
  budget.endWrite();
  assert.equal(budget.reserveInspection(), true);
  assert.equal(budget.reserveInspection(), false);
});

test("drained sequential work can exceed 64 events but never the session cap", () => {
  const budget = createEventBudget();
  assert.equal(MAX_EVENTS, 10_000);
  for (let index = 0; index < MAX_EVENTS - 2; index += 1) {
    assert.equal(budget.reserveInspection(), true);
    budget.beginWrite();
    budget.releaseInspection();
    budget.endWrite();
  }
  // Outstanding inspections reserve the last two possible event positions.
  assert.equal(budget.reserveInspection(), true);
  assert.equal(budget.reserveInspection(), true);
  assert.equal(budget.reserveInspection(), false);
  assert.equal(budget.atEventLimit(), false);
  budget.releaseInspection();
  assert.equal(budget.reserveInspection(), true);
  for (let index = 0; index < 2; index += 1) {
    budget.beginWrite();
    budget.releaseInspection();
    budget.endWrite();
  }
  assert.equal(budget.atEventLimit(), true);
  assert.equal(budget.reserveInspection(), false);
});
