import assert from "node:assert/strict";
import test from "node:test";
import { probeRuntime, PROBE_TIMEOUT_MS } from "../tools/probe-installed-runtime.mjs";

const probe = (runner, options = {}) => probeRuntime({ runner, platform: "win32", arch: "x64", ...options });
const closedKeys = ["platform", "arch", "nodeAvailable", "nodeVersion", "launchMode"];

test("missing, timed out and inaccessible runtimes return the same closed receipt", async () => {
  for (const code of ["ENOENT", "ETIMEDOUT", "EACCES", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
    const receipt = await probe(async () => {
      throw Object.assign(new Error("PRIVATE executable /private/user/node SECRET_ENV"), { code });
    });
    assert.deepEqual(receipt, {
      platform: "win32", arch: "x64", nodeAvailable: false, nodeVersion: null, launchMode: "unresolved",
    });
    assert.deepEqual(Object.keys(receipt), closedKeys);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|SECRET_ENV|executable/);
  }
});

test("stable versions distinguish availability from provisional launch compatibility", async () => {
  for (const [stdout, nodeVersion, launchMode] of [
    ["v20.19.0\n", "20.19.0", "unresolved"],
    ["v21.9.0\n", "21.9.0", "unresolved"],
    ["v22.0.0\n", "22.0.0", "node-candidate"],
    ["v22.18.0\r\n", "22.18.0", "node-candidate"],
    ["v24.0.1", "24.0.1", "node-candidate"],
  ]) {
    const receipt = await probe(async () => ({ stdout, stderr: "" }));
    assert.equal(receipt.nodeAvailable, true);
    assert.equal(receipt.nodeVersion, nodeVersion);
    assert.equal(receipt.launchMode, launchMode);
  }
});

test("malformed, prerelease, noisy and oversized output never reaches receipts", async () => {
  for (const stdout of [undefined, null, 22, "", "22.0.0", "v022.0.0", "v22.0", "v22.0.0-rc.1",
    "v22.0.0\nPRIVATE", "PRIVATE /users/name/node", "v22.0.0\n\n", "x".repeat(257)]) {
    const receipt = await probe(async () => ({ stdout, stderr: "" }));
    assert.equal(receipt.nodeAvailable, false);
    assert.equal(receipt.nodeVersion, null);
    assert.equal(receipt.launchMode, "unresolved");
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|users/);
  }
  assert.equal((await probe(async () => ({ stdout: "v22.0.0", stderr: "PRIVATE warning" }))).nodeAvailable, false);
});

test("probe uses a fixed version-only command with bounded execution and no shell", async () => {
  let calls = 0;
  await probe(async (command, args, options) => {
    calls += 1;
    assert.equal(command, "node");
    assert.deepEqual(args, ["--version"]);
    assert.deepEqual(options, {
      encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 256, windowsHide: true, shell: false,
    });
    return { stdout: "v22.0.0", stderr: "" };
  });
  assert.equal(calls, 1);
});

test("unsupported platform or architecture cannot be mistaken for proven support", async () => {
  const receipt = await probe(async () => ({ stdout: "v24.0.0" }), {
    platform: "/private/platform", arch: "SECRET_ARCH",
  });
  assert.deepEqual(receipt, {
    platform: "unknown", arch: "unknown", nodeAvailable: true, nodeVersion: "24.0.0", launchMode: "unresolved",
  });
});
