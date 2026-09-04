import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectChanges, parseNameStatus, trackedPaths } from "../tools/test-runner/git.mjs";
import { selectAffected, validateMatrix } from "../tools/test-runner/matrix.mjs";

const matrix = {
  schemaVersion: 1,
  inventory: { include: ["tests/**", "src/**"] },
  fullInventory: { include: ["tests/*.test.mjs"] },
  globalPaths: ["config/**"],
  suites: [
    { id: "fast", kind: "node-test", include: ["tests/fast.test.mjs"], tiers: ["fast", "full"] },
    { id: "slow", kind: "node-test", include: ["tests/slow.test.mjs"], tiers: ["full"] },
  ],
  ownership: [
    { paths: ["src/fast/**"], suites: ["fast"] },
    { paths: ["src/shared/**"], suites: ["fast", "slow"] },
  ],
};
const tracked = ["tests/fast.test.mjs", "tests/slow.test.mjs", "src/fast/a.mjs", "src/shared/b.mjs"];

test("affected selection unions owners and selects a changed test itself", () => {
  assert.deepEqual(selectAffected(matrix, tracked, ["src/shared/b.mjs"]), {
    suiteIds: ["fast", "slow"], fallbackReason: null,
  });
  assert.deepEqual(selectAffected(matrix, tracked, ["tests/slow.test.mjs"]), {
    suiteIds: ["fast", "slow"], fallbackReason: null,
  });
});

test("global and unknown changes fail closed to the full tier", () => {
  assert.match(selectAffected(matrix, tracked, ["config/matrix.json"]).fallbackReason, /^global path:/);
  assert.match(selectAffected(matrix, tracked, ["private/new.kind"]).fallbackReason, /^unknown path:/);
  assert.deepEqual(selectAffected(matrix, tracked, ["private/new.kind"]).suiteIds, ["fast", "slow"]);
});

test("matrix validation rejects omissions and duplicate full inventory", () => {
  assert.deepEqual(validateMatrix(matrix, tracked), []);
  const duplicate = structuredClone(matrix);
  duplicate.suites[1].include.push("tests/fast.test.mjs");
  assert.ok(validateMatrix(duplicate, tracked).some((error) => error.includes("count 2")));
  assert.ok(validateMatrix(matrix, [...tracked, "src/unowned/file.mjs"]).some(
    (error) => error.includes("unowned executable/test path"),
  ));
  const empty = structuredClone(matrix);
  empty.suites[0].include = ["tests/missing*.test.mjs"];
  assert.ok(validateMatrix(empty, tracked).some((error) => error.includes("match no tracked tests")));
});

test("name-status parsing preserves both rename paths and deletions", () => {
  const value = "R100\0old.py\0new.py\0D\0gone.py\0M\0kept.py\0";
  assert.deepEqual(parseNameStatus(value), ["old.py", "new.py", "gone.py", "kept.py"]);
});

test("git selection combines committed, staged, unstaged, deleted, renamed, and untracked paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-runner-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  try {
    git("init", "-q");
    git("config", "user.email", "tests@example.invalid");
    git("config", "user.name", "Test Runner");
    for (const name of ["committed.txt", "rename-old.py", "delete-me.py", "unstaged.py"]) {
      fs.writeFileSync(path.join(root, name), `${name}\n`);
    }
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    fs.appendFileSync(path.join(root, "committed.txt"), "changed\n");
    fs.rmSync(path.join(root, "delete-me.py"));
    git("add", "committed.txt", "delete-me.py");
    git("commit", "-qm", "committed changes");
    git("mv", "rename-old.py", "rename-new.py");
    fs.appendFileSync(path.join(root, "unstaged.py"), "unstaged\n");
    fs.writeFileSync(path.join(root, "untracked.py"), "untracked\n");
    const result = await collectChanges(root, base);
    assert.deepEqual(result.changedPaths, [
      "committed.txt", "delete-me.py", "rename-new.py", "rename-old.py",
      "unstaged.py", "untracked.py",
    ]);
    const runnable = await trackedPaths(root);
    assert.equal(runnable.includes("untracked.py"), true);
    assert.equal(runnable.includes("delete-me.py"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
