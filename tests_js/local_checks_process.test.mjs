import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalCommand } from "../tools/local-checks/process.mjs";

function settings(overrides = {}) {
  const output = { stdout: "", stderr: "" };
  return {
    output,
    options: {
      cwd: os.tmpdir(),
      label: "synthetic-process",
      timeoutMs: 4000,
      maxOutputBytes: 1024,
      stdout: (text) => { output.stdout += text; },
      stderr: (text) => { output.stderr += text; },
      ...overrides,
    },
  };
}

test("failed commands retain exit status and bounded diagnostic streams", async () => {
  const { options, output } = settings();
  const result = await runLocalCommand(process.execPath, ["-e", "process.stdout.write('synthetic stdout'); process.stderr.write('synthetic stderr'); process.exitCode=7;"], options);
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.match(output.stdout, /synthetic stdout/);
  assert.match(output.stderr, /synthetic stderr/);
  assert.ok(result.durationMs >= 0);
});

test("missing executable produces a failed receipt instead of rejecting or hanging", async () => {
  const { options } = settings();
  const result = await runLocalCommand(path.join(os.tmpdir(), "synthetic-unavailable-command-84912"), [], options);
  assert.equal(result.status, "failed");
  assert.equal(result.signal, "spawn-error");
  assert.notEqual(result.exitCode, 0);
});

test("command children cannot inherit Git variables, including explicit env overrides", async () => {
  const { options, output } = settings({ env: {
    GIT_DIR: "/synthetic/unavailable",
    GIT_INDEX_FILE: "/synthetic/index",
    GIT_WORK_TREE: "/synthetic/tree",
    LOCAL_CHECKS_SYNTHETIC: "retained",
  } });
  const code = "process.stdout.write(JSON.stringify({git:Object.keys(process.env).filter(k=>k.startsWith('GIT_')),retained:process.env.LOCAL_CHECKS_SYNTHETIC}));";
  const result = await runLocalCommand(process.execPath, ["-e", code], options);
  assert.equal(result.status, "passed");
  assert.deepEqual(JSON.parse(output.stdout.replace(/^\[synthetic-process\] /, "")), {
    git: [], retained: "retained",
  });
});

for (const stream of ["stdout", "stderr"]) {
  test(`${stream} output limit terminates the command and suppresses excess output`, async () => {
    const { options, output } = settings({ maxOutputBytes: 64 });
    const result = await runLocalCommand(process.execPath, ["-e", `process.${stream}.write('x'.repeat(8192)); setInterval(()=>{},1000);`], options);
    assert.equal(result.status, "failed");
    assert.equal(result.signal, "output-limit");
    assert.match(output.stderr, /output-limit/);
    assert.ok(!output[stream].includes("x".repeat(65)));
    assert.ok(result.durationMs < 3500);
  });
}

test("timeout terminates the owned descendant before it can write its delayed marker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-checks-process-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "unexpected-descendant-write.txt");
  const { options, output } = settings({ timeoutMs: 400, cwd: root });
  const descendant = "require('node:fs').writeFileSync('ready.txt','ready'); setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'unexpected'),2000);";
  const code = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(marker)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const result = await runLocalCommand(process.execPath, ["-e", code], options);
  assert.equal(await fs.readFile(path.join(root, "ready.txt"), "utf8"), "ready");
  assert.equal(result.status, "failed");
  assert.equal(result.signal, "timeout");
  assert.match(output.stderr, /terminating owned process group/);
  await new Promise((resolve) => setTimeout(resolve, 850));
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("interruption stops active work and prevents new commands in that coordinator", () => {
  const moduleUrl = new URL("../tools/local-checks/process.mjs", import.meta.url).href;
  const code = `
    import {runLocalCommand,interruptLocalChecks} from ${JSON.stringify(moduleUrl)};
    const options={cwd:process.cwd(),label:'interrupt-fixture',stdout:()=>{},stderr:()=>{},timeoutMs:4000};
    const active=runLocalCommand(process.execPath,['-e','setInterval(()=>{},1000)'],options);
    setTimeout(interruptLocalChecks,100);
    const first=await active;
    const second=await runLocalCommand(process.execPath,['-e','process.exit(0)'],options);
    process.stdout.write(JSON.stringify({first,second}));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8", timeout: 5000, maxBuffer: 4096,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const { first, second } = JSON.parse(result.stdout);
  assert.equal(first.status, "failed");
  assert.equal(first.signal, "interrupted");
  assert.equal(second.status, "failed");
  assert.equal(second.signal, "interrupted");
  assert.equal(second.exitCode, 130);
  assert.equal(second.durationMs, 0);
});
