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

const { collectLocalMacHost, validateLocalMacHost, assertLocalMacHostUnchanged } =
  await import('../tools/migration/local-mac-host.mjs');
const macDeferred = [
  'Linux/Windows native qualification', 'other Mac OS/CPU/runtime versions',
  'clean-host/offline customer installation', 'browser and native account integrations',
  'physical durability and release deployment',
];
function macIdentityFixture() {
  return { schemaVersion: 1, scope: 'mac-dogfood', platform: 'darwin', arch: 'arm64',
    macOS: { version: '26.4.1', build: '25E253' },
    node: { requested: 'process.execPath', resolved: '/synthetic/node', sha256: 'a'.repeat(64), version: '22.22.3', unicode: '17.0' },
    python: ['python3', 'python3.12', 'python3.13', 'python3.14'].map((alias, index) => {
      const profile = index === 0 ? '3.14' : alias.slice(6);
      return { alias, resolved: `/synthetic/${alias}`, sha256: 'b'.repeat(64), version: `${profile}.1`,
        implementation: 'CPython', profile, filesystemEncoding: 'utf-8', filesystemErrors: 'surrogateescape' };
    }),
    compiler: { requested: 'clang', resolved: '/synthetic/clang', sha256: 'c'.repeat(64), version: 'synthetic clang\n' },
    deferred: [...macDeferred] };
}

test('P02 Mac dogfood scope preserves deferred release qualification', () => {
  const fixture = macIdentityFixture();
  assert.doesNotThrow(() => validateLocalMacHost(fixture));
  assert.doesNotThrow(() => assertLocalMacHostUnchanged(fixture, structuredClone(fixture)));
  for (const mutate of [
    value => { value.scope = 'release'; },
    value => { value.platform = 'linux'; },
    value => { value.macOS.build = 'other'; },
    value => { value.node.unicode = '16.0'; },
    value => { value.node.sha256 = 'x'.repeat(64); },
    value => { value.compiler.sha256 = 'A'.repeat(64); },
    value => { value.compiler.extra = true; },
    value => { value.python[1].alias = 'python3.13'; },
    value => { value.python[1].profile = '3.13'; },
    value => { value.python[0].profile = '3.11'; },
    value => { value.python[0].version = '3.14'; },
    value => { value.python[0].resolved = 'relative'; },
    value => { value.python[0].filesystemErrors = 'strict'; },
    value => { value.python.pop(); },
    value => { value.python[1] = value.python[0]; },
    value => { value.extra = true; },
    value => { value.deferred.pop(); },
    value => { value.deferred.push('passed'); },
    value => { Object.defineProperty(value.node, 'resolved', { get() { throw new Error('must not call'); } }); },
  ]) {
    const invalid = structuredClone(fixture);
    mutate(invalid);
    assert.throws(() => validateLocalMacHost(invalid), TypeError);
  }
  for (const mutate of [
    value => { value.node.sha256 = 'd'.repeat(64); },
    value => { value.compiler.resolved = '/synthetic/replaced'; },
    value => { value.python[0].resolved = '/synthetic/replaced'; },
    value => { value.python[0].version = '3.14.2'; },
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed);
    assert.throws(() => assertLocalMacHostUnchanged(fixture, changed), /identity changed/);
  }
});

test('P02 local Mac identity binds actual executables and rejects drift', async t => {
  let before;
  try { before = await collectLocalMacHost(); }
  catch (error) {
    if (error.code === 'LOCAL_MAC_HOST_MISMATCH') {
      t.skip('Frozen Mac dogfood host required; no identity acceptance');
      return;
    }
    throw error;
  }
  const after = await collectLocalMacHost();
  validateLocalMacHost(before);
  assertLocalMacHostUnchanged(before, after);
  assert.equal(before.python.length, 4);
  assert.deepEqual(before.deferred, macDeferred);
  const changed = structuredClone(after);
  changed.python[0].sha256 = before.python[0].sha256 === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  assert.throws(() => assertLocalMacHostUnchanged(before, changed), /identity changed/);
  t.diagnostic(JSON.stringify({ kind: 'actual-local-mac-identity', before, after }));
});
