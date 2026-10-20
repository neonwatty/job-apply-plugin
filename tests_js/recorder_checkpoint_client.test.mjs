import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("recorder options require one safe child of .qa-private and loopback CDP", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "recorder-options-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const output = path.join(privateRoot, "qa-session-1");

  const valid = await validateRecorderOptions({
    cdpUrl: "http://127.0.0.1:9222",
    output,
  });
  assert.equal(valid.output, output);

  for (const invalid of [
    {},
    { cdpUrl: "http://example.test:9222", output },
    { cdpUrl: "file:///tmp/socket", output },
    { cdpUrl: "http://127.0.0.1:9222", output: privateRoot },
    {
      cdpUrl: "http://127.0.0.1:9222",
      output: path.join(output, "nested"),
    },
  ]) {
    await assert.rejects(
      validateRecorderOptions(invalid),
      (error) => !error.message.includes(directory) &&
        !error.message.includes("example.test"),
    );
  }

  const nonempty = path.join(privateRoot, "nonempty");
  await mkdir(nonempty);
  await writeFile(path.join(nonempty, "private.txt"), "secret");
  await assert.rejects(validateRecorderOptions({
    cdpUrl: "http://[::1]:9222",
    output: nonempty,
  }), /unsafe session directory/);

  const target = path.join(privateRoot, "target");
  const linked = path.join(privateRoot, "linked");
  await mkdir(target);
  await symlink(target, linked);
  await assert.rejects(validateRecorderOptions({
    cdpUrl: "http://localhost:9222",
    output: linked,
  }), /unsafe session directory/);
});

test("checkpoint client aborts a stalled local request by its deadline", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkpoint-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  const session = path.join(privateRoot, "qa-session-timeout");
  await mkdir(path.join(session, "checkpoints"), { recursive: true, mode: 0o700 });
  const token = "t".repeat(43);
  let clientDisconnected;
  const disconnected = new Promise((resolve) => { clientDisconnected = resolve; });
  const server = http.createServer((request, response) => {
    request.resume();
    response.once("close", clientDisconnected);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(path.join(session, "control.json"), `${JSON.stringify({
    port: server.address().port,
    token,
  })}\n`, { mode: 0o600 });

  const started = Date.now();
  const result = await runNode([
    "qa/recorder.mjs", "checkpoint", "--session", session,
    "--kind", "application-opened",
  ], 34000);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /recorder unavailable/);
  assert.ok(Date.now() - started < 33000);
  await withTimeout(disconnected, 1000, "checkpoint client did not abort");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(await readdir(path.join(session, "checkpoints")), []);
});

test("record refuses a login page before creating private evidence", async (t) => {
  const site = await startSyntheticSite(t);
  const { cdpUrl } = await startIndependentChromium(t, `${site}/login`);
  const directory = await mkdtemp(path.join(tmpdir(), "login-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateRoot = path.join(directory, ".qa-private");
  await mkdir(privateRoot, { mode: 0o700 });
  const session = path.join(privateRoot, "qa-session-login");

  const result = await runNode([
    "qa/recorder.mjs", "record", "--cdp-url", cdpUrl, "--output", session,
  ], 10000);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /sensitive page refused/);
  assert.doesNotMatch(result.stderr, /Sign in|password|127\.0\.0\.1/);
  await assert.rejects(access(path.join(session, "capture-receipt.json")));
  await assert.rejects(access(path.join(session, "events.jsonl")));
});
