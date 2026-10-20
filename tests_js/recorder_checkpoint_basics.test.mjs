import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("sanitizeObservedControl retains metadata and strips applicant values", () => {
  assert.deepEqual(
    sanitizeObservedControl({
      role: "textbox",
      label: "Private Person email",
      value: "private@example.invalid",
      checked: true,
      filename: "private-resume.pdf",
      files: ["private-resume.pdf"],
      textContent: "Private Person",
      required: true,
    }),
    {
      role: "textbox",
      sourceLabel: "Private Person email",
      required: true,
    },
  );
});

test("checkpoint kinds are closed and value-free on rejection", () => {
  for (const kind of [
    "application-opened",
    "step-advanced",
    "validation-observed",
    "review-reached",
    "final-action-boundary",
  ]) {
    assert.equal(validateCheckpointKind(kind), kind);
  }
  assert.throws(
    () => validateCheckpointKind("secret-kind"),
    (error) => error.message === "invalid checkpoint kind" &&
      !error.message.includes("secret-kind"),
  );
});

test("checkpoint commit rolls back cancellation after rename and reuses sequence", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "checkpoint-commit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const finalDirectory = path.join(directory, "0001-application-opened");
  const firstTemporary = path.join(directory, ".tmp-first");
  await mkdir(firstTemporary, { mode: 0o700 });
  await writeFile(path.join(firstTemporary, "checkpoint.json"), "first", { mode: 0o600 });
  const controller = new AbortController();
  const lifecycle = [];

  await assert.rejects(commitCheckpoint({
    temporaryDirectory: firstTemporary,
    checkpointDirectory: finalDirectory,
    signal: controller.signal,
    isShuttingDown: () => false,
    updateLifecycle: () => lifecycle.push("application-opened"),
    renameDirectory: async (source, destination) => {
      await rename(source, destination);
      controller.abort();
    },
    removeDirectory: (target) => rm(target, { recursive: true, force: true }),
  }), /operation canceled/);
  await assert.rejects(access(finalDirectory));
  await assert.rejects(access(firstTemporary));
  assert.deepEqual(lifecycle, []);

  const secondTemporary = path.join(directory, ".tmp-second");
  await mkdir(secondTemporary, { mode: 0o700 });
  await writeFile(path.join(secondTemporary, "checkpoint.json"), "second", { mode: 0o600 });
  await commitCheckpoint({
    temporaryDirectory: secondTemporary,
    checkpointDirectory: finalDirectory,
    signal: new AbortController().signal,
    isShuttingDown: () => false,
    updateLifecycle: () => lifecycle.push("application-opened"),
    renameDirectory: rename,
    removeDirectory: (target) => rm(target, { recursive: true, force: true }),
  });
  assert.equal(await readFile(path.join(finalDirectory, "checkpoint.json"), "utf8"), "second");
  assert.deepEqual(lifecycle, ["application-opened"]);
});
