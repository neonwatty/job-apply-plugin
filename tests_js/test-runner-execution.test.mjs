import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeSuites, pythonExecutable, suiteCommand } from "../tools/test-runner/execute.mjs";
import { runStreaming } from "../tools/test-runner/process.mjs";
import { buildReceipt, writeReceipt } from "../tools/test-runner/receipt.mjs";
import { parseArguments } from "../tools/test-runner.mjs";

test("platform Python selection and generated test commands are explicit", () => {
  assert.equal(pythonExecutable("win32"), "python");
  assert.equal(pythonExecutable("linux"), "python3");
  assert.deepEqual(suiteCommand({
    kind: "python-unittest", include: ["tests/test_a.py"], exclude: [],
  }, ["tests/test_a.py"], "win32"), ["python", "-m", "unittest", "-v", "tests.test_a"]);
  assert.deepEqual(suiteCommand({
    kind: "node-test", include: ["tests/a.test.mjs"], exclude: [],
  }, ["tests/a.test.mjs"]), [process.execPath, "--test", "--test-concurrency=1", "tests/a.test.mjs"]);
});

test("suite execution streams prefixed failures and aggregates in matrix order", async () => {
  let stdout = "";
  let stderr = "";
  const suites = [
    { id: "passing", kind: "command", command: [process.execPath, "-e", "console.log('ok')"] },
    { id: "failing", kind: "command", command: [process.execPath, "-e", "console.error('bad');process.exit(7)"] },
  ];
  const results = await executeSuites(process.cwd(), suites, [], {
    concurrency: 2,
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
  });
  assert.deepEqual(results.map(({ id, status, exitCode }) => ({ id, status, exitCode })), [
    { id: "passing", status: "passed", exitCode: 0 },
    { id: "failing", status: "failed", exitCode: 7 },
  ]);
  assert.match(stdout, /^\[passing\] ok/m);
  assert.match(stderr, /^\[failing\] bad/m);
});

test("suite execution honors its concurrency bound and runs each suite once", async () => {
  let active = 0;
  let maximum = 0;
  const calls = [];
  const run = async (_executable, args) => {
    calls.push(args[1]);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { status: "passed", exitCode: 0, durationMs: 10 };
  };
  const suites = ["a", "b", "c", "d"].map((id) => ({
    id, kind: "command", command: [process.execPath, "-e", id],
  }));
  const results = await executeSuites(process.cwd(), suites, [], { concurrency: 2, run });
  assert.equal(maximum, 2);
  assert.deepEqual(calls.sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(results.map(({ id }) => id), ["a", "b", "c", "d"]);
});

test("process execution terminates hangs and bounds noisy output", async () => {
  let stderr = "";
  const timed = await runStreaming(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    label: "hung", timeoutMs: 30, maxOutputBytes: 32,
    stdout: () => {}, stderr: (value) => { stderr += value; },
  });
  assert.equal(timed.status, "failed");
  assert.equal(timed.exitCode, 124);
  assert.match(stderr, /timed out after 30ms/);

  let stdout = "";
  const noisy = await runStreaming(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000))"], {
    label: "noisy", timeoutMs: 1000, maxOutputBytes: 32,
    stdout: (value) => { stdout += value; }, stderr: () => {},
  });
  assert.equal(noisy.status, "passed");
  assert.match(stdout, /output truncated after 32 bytes/);
  assert.equal((stdout.match(/x/g) ?? []).length, 32);
});

test("timeout terminates an owned grandchild process tree", { skip: process.platform === "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-runner-tree-"));
  const pidFile = path.join(root, "grandchild.pid");
  const grandchild = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parent = [
    "const {spawn}=require('child_process'),fs=require('fs');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});`,
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
  ].join("");
  try {
    const result = await runStreaming(process.execPath, ["-e", parent], {
      label: "tree", timeoutMs: 200, maxOutputBytes: 32,
      stdout: () => {}, stderr: () => {},
    });
    assert.equal(result.exitCode, 124);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 10 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        alive = false;
      }
    }
    assert.equal(alive, false, "grandchild survived its owned process-group timeout");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("receipts contain selection and timing metadata but no commands, output, or environment", async () => {
  const receipt = buildReceipt({
    baseSha: "a".repeat(40), headSha: "b".repeat(40),
    changedPaths: ["src/safe.mjs"], suiteIds: ["unit"], fallbackReason: null,
  }, [{
    id: "unit", status: "passed", durationMs: 12,
    command: "PRIVATE_COMMAND", output: "PRIVATE_OUTPUT", env: { TOKEN: "PRIVATE_TOKEN" },
  }]);
  const serialized = JSON.stringify(receipt);
  assert.equal(receipt.status, "passed");
  for (const secret of ["PRIVATE_COMMAND", "PRIVATE_OUTPUT", "PRIVATE_TOKEN"]) {
    assert.equal(serialized.includes(secret), false);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-runner-receipt-"));
  try {
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested/receipt.json"), "old", { mode: 0o644 });
    await writeReceipt(root, "nested/receipt.json", receipt);
    const stored = fs.readFileSync(path.join(root, "nested/receipt.json"), "utf8");
    assert.deepEqual(JSON.parse(stored), receipt);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(root, "nested/receipt.json")).mode & 0o777, 0o600);
      const target = path.join(root, "target.json");
      const link = path.join(root, "link.json");
      fs.writeFileSync(target, "untouched", { mode: 0o644 });
      fs.symlinkSync(target, link);
      await writeReceipt(root, "link.json", receipt);
      assert.equal(fs.readFileSync(target, "utf8"), "untouched");
      assert.equal(fs.lstatSync(link).isFile(), true);
      assert.equal(fs.statSync(link).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI parsing rejects ambiguity and accepts bounded concurrency", () => {
  assert.deepEqual(parseArguments(["affected", "--base", "origin/staging", "--receipt", "out.json"]), {
    tier: "affected", base: "origin/staging", receipt: "out.json", concurrency: null,
  });
  assert.throws(() => parseArguments(["mystery"]), /unknown test tier/);
  assert.throws(() => parseArguments(["full", "--concurrency", "0"]), /concurrency/);
});
