import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeSuites, pythonExecutable, suiteCommand } from "../tools/test-runner/execute.mjs";
import { createLinePrefixer, runStreaming } from "../tools/test-runner/process.mjs";
import { runLocalCommand } from "../tools/local-checks/process.mjs";
import { buildReceipt, writeReceipt } from "../tools/test-runner/receipt.mjs";
import { parseArguments } from "../tools/test-runner.mjs";

async function assertProcessGone(pid) {
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
}

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
  assert.equal(noisy.status, "failed");
  assert.equal(noisy.exitCode, 130);
  assert.equal(noisy.signal, "output-limit");
  assert.match(stdout, /output truncated after 32 bytes/);
  assert.equal((stdout.match(/x/g) ?? []).length, 32);
});

test("timeout terminates an owned grandchild process tree", async (t) => {
  if (process.platform === "win32") { t.skip(); return; }
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
    await assertProcessGone(pid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("timeout retains group cleanup after the direct parent exits", async (t) => {
  if (process.platform === "win32") { t.skip(); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-runner-orphan-"));
  const pidFile = path.join(root, "grandchild.pid");
  const grandchild = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parent = [
    "const {spawn}=require('child_process'),fs=require('fs');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  try {
    const result = await runStreaming(process.execPath, ["-e", parent], {
      label: "orphan", timeoutMs: 200, maxOutputBytes: 32,
      stdout: () => {}, stderr: () => {},
    });
    assert.equal(result.exitCode, 124);
    await assertProcessGone(Number(fs.readFileSync(pidFile, "utf8")));
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


test("stream prefixes empty lines without trailing spaces and preserves nonempty payloads", async () => {
  let stdout = "";
  let stderr = "";
  const program = [
    "const chunks=[Buffer.from('\\n\\n  \\t\\r\\npart'),Buffer.from('ial\\n'),Buffer.from([0xf0,0x90]),Buffer.from([0x80,0x80]),Buffer.from(' tail')];",
    "let i=0;function next(){if(i===chunks.length)return;const c=chunks[i++];process.stdout.write(c);process.stderr.write(c);setTimeout(next,10)}next();",
  ].join("");
  const result = await runStreaming(process.execPath, ["-e", program], {
    label: "lines", timeoutMs: 2000,
    stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; },
  });
  assert.equal(result.status, "passed");
  const expected = "[lines]\n[lines]\n[lines]   \t\r\n[lines] partial\n[lines] \u{10000} tail\n";
  assert.equal(stdout, expected);
  assert.equal(stderr, expected);
  let localStdout = "";
  let localStderr = "";
  const local = await runLocalCommand(process.execPath, ["-e", program], {
    label: "lines", cwd: process.cwd(), timeoutMs: 2000,
    stdout: (value) => { localStdout += value; },
    stderr: (value) => { localStderr += value; },
  });
  assert.equal(local.status, "passed");
  assert.equal(localStdout, expected.slice(0, -1));
  assert.equal(localStderr, expected.slice(0, -1));

  let limited = "";
  const limitResult = await runLocalCommand(process.execPath, ["-e",
    "process.stderr.write('kept');setTimeout(()=>process.stderr.write('x'.repeat(100)),30);setInterval(()=>{},1000)",
  ], {
    label: "limited", cwd: process.cwd(), timeoutMs: 2000, maxOutputBytes: 8,
    stdout: () => {}, stderr: (value) => { limited += value; },
  });
  assert.equal(limitResult.status, "failed");
  assert.equal(limitResult.exitCode, 130);
  assert.equal(limitResult.signal, "output-limit");
  assert.equal(limited, "[limited] kept[limited] output-limit; terminating owned process group\n");

  let timedOutput = "";
  const localTimeout = await runLocalCommand(process.execPath, ["-e",
    "process.stderr.write('partial');setInterval(()=>{},1000)",
  ], {
    label: "local-timeout", cwd: process.cwd(), timeoutMs: 200, maxOutputBytes: 64,
    stdout: () => {}, stderr: (value) => { timedOutput += value; },
  });
  assert.equal(localTimeout.exitCode, 124);
  assert.equal(localTimeout.signal, "timeout");
  assert.equal(timedOutput, "[local-timeout] partial[local-timeout] timeout; terminating owned process group\n");
  for (const finalNewline of [false, true]) {
    let output = "";
    const formatter = createLinePrefixer("[direct]", (value) => { output += value; }, { finalNewline });
    for (const chunk of ["\n", "a", "b\n\n", " \t\r"]) formatter.write(Buffer.from(chunk));
    formatter.flush();
    formatter.flush();
    assert.equal(output, "[direct]\n[direct] ab\n[direct]\n[direct]  \t\r" + (finalNewline ? "\n" : ""));
  }
});

async function streamed(program, limit, timeoutMs = 2000) {
  let stdout = '', stderr = '';
  const result = await runStreaming(process.execPath, ['-e', program], {
    label: 'boundary', maxOutputBytes: limit, timeoutMs,
    stdout: value => { stdout += value; }, stderr: value => { stderr += value; },
  });
  return { result, stdout, stderr };
}
function overflowResult(result) {
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 130);
  assert.equal(result.signal, 'output-limit');
}

test('P11 streamed output enforces independent stdout and stderr byte boundaries', async () => {
  for (const stream of ['stdout', 'stderr']) {
    for (const [limit, length] of [[0, 0], [0, 1], [8, 7], [8, 8], [8, 9]]) {
      const observed = await streamed(`process.${stream}.write('x'.repeat(${length}))`, limit);
      if (length > limit) overflowResult(observed.result);
      else assert.equal(observed.result.status, 'passed');
      const prefix = Math.min(limit, length);
      assert.equal(observed[stream], (prefix ? `[boundary] ${'x'.repeat(prefix)}\n` : '')
        + (length > limit ? `[boundary] [output truncated after ${limit} bytes]\n` : ''));
      assert.equal(observed[stream === 'stdout' ? 'stderr' : 'stdout'], '');
    }
  }
  const both = await streamed("process.stdout.write('12345678');process.stderr.write('abcdefgh')", 8);
  assert.equal(both.result.status, 'passed');
  assert.equal(both.stdout, '[boundary] 12345678\n');
  assert.equal(both.stderr, '[boundary] abcdefgh\n');
  for (const stream of ['stdout', 'stderr']) {
    const split = await streamed(`process.${stream}.write('1234');setTimeout(()=>process.${stream}.write('56789'),30)`, 8);
    overflowResult(split.result);
    assert.equal(split[stream], '[boundary] 12345678\n[boundary] [output truncated after 8 bytes]\n');
  }
  const unicode = "process.stdout.write(Buffer.from([10,240,144]));setTimeout(()=>process.stdout.write(Buffer.from([128,128,10,120])),20)";
  const exact = await streamed(unicode, 7);
  assert.equal(exact.result.status, 'passed');
  assert.equal(exact.stdout, '[boundary]\n[boundary] \u{10000}\n[boundary] x\n');
  const clipped = await streamed(unicode, 3);
  overflowResult(clipped.result);
  assert.equal(clipped.stdout, '[boundary]\n[boundary] \ufffd\n[boundary] [output truncated after 3 bytes]\n');
  for (const offending of ['stdout', 'stderr']) {
    const other = offending === 'stdout' ? 'stderr' : 'stdout';
    for (const chunks of [
      [[0xf0, 0x90], [0x80, 0x80], '\u{10000}'],
      [[112, 97], [114, 116], 'part'],
    ]) {
      const program = "process.on('SIGTERM',()=>{});"
        + `process.${other}.write(Buffer.from(${JSON.stringify(chunks[0])}));`
        + `setTimeout(()=>process.${offending}.write('x'.repeat(9)),40);`
        + `setTimeout(()=>process.${other}.write(Buffer.from(${JSON.stringify(chunks[1])})),100);`
        + "setTimeout(()=>process.exit(0),150);";
      const crossed = await streamed(program, 8);
      overflowResult(crossed.result);
      assert.equal(crossed[other], `[boundary] ${chunks[2]}\n`, 'overflow must not finalize the other stream decoder or line');
      assert.equal(crossed[offending], '[boundary] xxxxxxxx\n[boundary] [output truncated after 8 bytes]\n');
    }
  }
});

test('P11 output overflow cannot pass after zero exit or competing termination', async () => {
  for (const streams of [['stdout'], ['stderr'], ['stdout', 'stderr']]) {
    const code = "process.on('SIGTERM',()=>{});" + streams.map(stream => `process.${stream}.write('x'.repeat(40));`).join('') + 'process.exitCode=0;';
    const value = await streamed(code, 8);
    overflowResult(value.result);
    for (const stream of streams) assert.equal((value[stream].match(/output truncated/g) ?? []).length, 1);
  }
  const repeated = await streamed("process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(40));setInterval(()=>{process.stdout.write('more');process.stderr.write('y'.repeat(40))},10)", 8, 200);
  overflowResult(repeated.result);
  assert.equal((repeated.stdout.match(/output truncated/g) ?? []).length, 1);
  assert.equal((repeated.stderr.match(/output truncated/g) ?? []).length, 1);
  assert.ok(!repeated.stderr.includes('timed out'));
  const timeoutFirst = await streamed("process.on('SIGTERM',()=>{process.stdout.write('x'.repeat(40))});setInterval(()=>{},1000)", 8, 200);
  assert.equal(timeoutFirst.result.status, 'failed');
  assert.equal(timeoutFirst.result.exitCode, 124);
  assert.equal(timeoutFirst.result.signal, 'timeout');
  assert.match(timeoutFirst.stdout, /output truncated after 8 bytes/);
});

test('P11 output overflow retains cleanup for an owned surviving descendant', async t => {
  if (process.platform === 'win32') { t.skip(); return; }
  for (const parentExits of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overflow-tree-'));
    const pidFile = path.join(root, 'child.pid');
    const stopFile = path.join(root, 'stop');
    const worker = "const fs=require('node:fs');process.on('SIGTERM',()=>{});process.send('ready');"
      + `setInterval(()=>{if(fs.existsSync(${JSON.stringify(stopFile)}))process.exit(0)},10);`
      + "setTimeout(()=>process.exit(2),8000)";
    const parent = [
      "const {spawn}=require('node:child_process'),fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:['ignore','ignore','ignore','ipc']});`,
      "process.on('SIGTERM',()=>{});",
      `child.once('message',()=>{fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
      "child.disconnect();process.stdout.write('x'.repeat(100),()=>{",
      parentExits ? 'process.exit(0);' : 'setInterval(()=>{},1000);',
      '});});',
    ].join('');
    try {
      const value = await streamed(parent, 8);
      overflowResult(value.result);
      await assertProcessGone(Number(fs.readFileSync(pidFile, 'utf8')));
    } finally {
      fs.writeFileSync(stopFile, 'stop');
      if (fs.existsSync(pidFile)) await assertProcessGone(Number(fs.readFileSync(pidFile, 'utf8')));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('P11 incomplete output fails suite receipts without leaking captured data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overflow-receipt-'));
  const program = "process.stdout.write('PRIVATE_OUTPUT'.repeat(20));process.exitCode=0";
  const suites = [
    { id: 'clipped', kind: 'command', command: [process.execPath, '-e', program], maxOutputBytes: 8, env: { PRIVATE_TOKEN: 'PRIVATE_VALUE' } },
    { id: 'complete', kind: 'command', command: [process.execPath, '-e', "process.stdout.write('12345678')"], maxOutputBytes: 8 },
  ];
  try {
    const results = await executeSuites(root, suites, [], { concurrency: 1, stdout: () => {}, stderr: () => {} });
    assert.deepEqual(results.map(row => [row.id, row.status]), [['clipped', 'failed'], ['complete', 'passed']]);
    overflowResult(results[0]);
    assert.equal(results[1].exitCode, 0);
    const receipt = buildReceipt({ suiteIds: ['clipped', 'complete'] }, results);
    assert.equal(receipt.status, 'failed');
    assert.deepEqual(receipt.timings.map(row => [row.id, row.status]), [['clipped', 'failed'], ['complete', 'passed']]);
    await writeReceipt(root, 'receipt.json', receipt);
    const bytes = fs.readFileSync(path.join(root, 'receipt.json'), 'utf8');
    assert.deepEqual(JSON.parse(bytes), receipt);
    for (const secret of [program, 'PRIVATE_OUTPUT', 'PRIVATE_TOKEN', 'PRIVATE_VALUE']) assert.ok(!bytes.includes(secret));
    assert.equal(buildReceipt({ suiteIds: ['complete'] }, [results[1]]).status, 'passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
