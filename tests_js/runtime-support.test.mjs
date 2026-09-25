import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test from "node:test";
import { probeRuntime, PROBE_TIMEOUT_MS } from "../tools/probe-installed-runtime.mjs";
import { qaBrowserInvocation, qaHostEnvironment, selectMacSdk, selectSupportedPython,
  selectSupportedPythonProfiles, supportedPythonProfiles } from "../tools/run-qa-browser.mjs";

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

test("broad QA selects a supported CPython on macOS without changing other platforms", () => {
  const discoveries = [];
  const probes = [];
  const selections = selectSupportedPythonProfiles({ platform: "darwin",
    discover: version => { discoveries.push(version); return `/synthetic/${version}`; },
    probe: executable => {
      probes.push(executable);
      const version = executable.slice(executable.lastIndexOf('/') + 1);
      return JSON.stringify({ implementation: "CPython", version,
        profile: version.split('.').slice(0, 2).join('.'), executable: process.execPath });
    },
  });
  assert.deepEqual(discoveries, supportedPythonProfiles.map(row => row.version));
  assert.deepEqual(probes, supportedPythonProfiles.map(row => `/synthetic/${row.version}`));
  assert.deepEqual(selections, supportedPythonProfiles.map(row => ({ ...row, executable: process.execPath })));
  const primary = selectSupportedPython({ platform: "darwin",
    discover: version => `/synthetic/${version}`,
    probe: executable => {
      const version = executable.slice(executable.lastIndexOf('/') + 1);
      return JSON.stringify({ implementation: "CPython", version,
        profile: version.split('.').slice(0, 2).join('.'), executable: process.execPath });
    },
  });
  assert.deepEqual(primary, selections[0]);
  assert.throws(() => selectSupportedPythonProfiles({ platform: "darwin", discover: () => null,
    probe: () => JSON.stringify({ implementation: "CPython", version: "3.12.14",
      profile: "3.12", executable: process.execPath }) }), /requires evidence-bound python3\.12 3\.12\.13/);
  assert.equal(selectSupportedPython({ platform: "linux", probe: () => { throw Error("must not probe"); } }), null);
  const sdkCalls = [];
  const sdk = selectMacSdk({ platform: "darwin", probe: args => {
    sdkCalls.push(args);
    return args[0] === "--show-sdk-path" ? "/synthetic/sdk\n" : `${process.execPath}\n`;
  }});
  assert.deepEqual(sdkCalls, [["--show-sdk-path"], ["--find", "clang"]]);
  assert.deepEqual(sdk, { path: "/synthetic/sdk", compiler: process.execPath });
  assert.throws(() => selectMacSdk({ platform: "darwin", probe: args =>
    args[0] === "--show-sdk-path" ? "relative-sdk" : process.execPath }), /absolute SDK and Clang paths/);
  const host = qaHostEnvironment({ platform: "darwin", selections, sdk,
    baseEnvironment: { ...process.env, PYTHON: "/unreviewed/python" } });
  assert.equal(host.environment.SDKROOT, sdk.path);
  assert.equal(host.environment.JOB_APPLY_QA_XCRUN_CLANG, sdk.compiler);
  assert.equal(host.environment.JOB_APPLY_CONTRACT_PYTHON.endsWith("/python3"), true);
  assert.equal(realpathSync(host.environment.JOB_APPLY_CONTRACT_PYTHON), process.execPath);
  assert.equal(realpathSync(host.environment.PYTHON), process.execPath);
  host.cleanup();
  const mac = qaBrowserInvocation({ platform: "darwin", selections, sdk });
  assert.equal(mac.options.env.SDKROOT, sdk.path);
  assert.equal(mac.options.env.JOB_APPLY_QA_XCRUN_CLANG, sdk.compiler);
  assert.equal(mac.options.env.JOB_APPLY_CONTRACT_PYTHON.endsWith("/python3"), true);
  assert.equal(realpathSync(mac.options.env.JOB_APPLY_CONTRACT_PYTHON), process.execPath);
  assert.equal(realpathSync(mac.options.env.PYTHON), process.execPath);
  for (const profile of supportedPythonProfiles) {
    assert.equal(realpathSync(mac.options.env.JOB_APPLY_CONTRACT_PYTHON.replace(/python3$/, profile.alias)),
      process.execPath);
  }
  mac.cleanup();
  const nonMac = qaBrowserInvocation({ platform: "linux", selections: null });
  assert.equal(nonMac.options.env.PATH, process.env.PATH);
  assert.equal(nonMac.options.env.JOB_APPLY_CONTRACT_PYTHON, process.env.JOB_APPLY_CONTRACT_PYTHON);
  assert.equal(nonMac.options.env.PYTHON, process.env.PYTHON);
  assert.equal(nonMac.options.env.SDKROOT, process.env.SDKROOT);
  assert.equal(nonMac.options.env.JOB_APPLY_QA_XCRUN_CLANG, process.env.JOB_APPLY_QA_XCRUN_CLANG);
  nonMac.cleanup();
});

const { collectLocalMacHost, validateLocalMacHost, assertLocalMacHostUnchanged,
  observePythonAlias, assertPythonAliasUnchanged } =
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
  const developerShimFixture = structuredClone(fixture);
  developerShimFixture.python[0].version = '3.9.6';
  developerShimFixture.python[0].profile = '3.9';
  assert.doesNotThrow(() => validateLocalMacHost(developerShimFixture));
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

test('P02 local Mac identity follows launcher-reported executable and rejects its drift', async () => {
  const reported = { resolved: '/actual/python3', version: '3.9.6', implementation: 'CPython',
    profile: '3.9', filesystemEncoding: 'utf-8', filesystemErrors: 'surrogateescape' };
  const commands = [];
  let sha256 = 'a'.repeat(64);
  const operations = {
    resolveAlias: async alias => {
      assert.equal(alias, 'python3');
      return '/usr/bin/python3';
    },
    run: async (command, args) => {
      commands.push(command);
      assert.deepEqual(args.slice(0, 3), ['-I', '-B', '-c']);
      return JSON.stringify(reported);
    },
    binaryIdentity: async executable => {
      assert.equal(executable, reported.resolved);
      return { resolved: executable, sha256, stat: ['synthetic-stat'] };
    },
  };
  const before = await observePythonAlias('python3', operations);
  assert.deepEqual(commands, ['python3', '/usr/bin/python3']);
  assert.equal(before.identity.resolved, reported.resolved);
  assert.equal(before.identity.sha256, sha256);
  sha256 = 'b'.repeat(64);
  const after = await observePythonAlias('python3', operations);
  assert.throws(() => assertPythonAliasUnchanged(before, after), /Python executable changed/);
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
