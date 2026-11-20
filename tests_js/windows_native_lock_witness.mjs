import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

const [artifact, root, scenario] = process.argv.slice(2);
const native = createRequire(import.meta.url)(artifact);
const lockPath = join(root, 'lock');

function probeInChild() {
  // Leave the descriptor open to exercise release on process exit.
  const script = `
    const [artifact, path] = process.argv.slice(1);
    const descriptor = require('node:fs').openSync(path, 'r+');
    process.stdout.write(String(require(artifact).tryLock(descriptor)));
  `;
  const result = spawnSync(process.execPath, ['-e', script, artifact, lockPath], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function assertLockReleased(descriptor) {
  const deadline = Date.now() + 3_000;
  do {
    if (native.tryLock(descriptor)) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail('Lock remained held after its descriptor closed or its process exited');
}

async function verifyLock() {
  writeFileSync(lockPath, '1234\n');
  const first = openSync(lockPath, 'r+');
  try {
    const second = openSync(lockPath, 'r+');
    try {
      assert.equal(native.tryLock(first), true, 'First descriptor can acquire the lock');
      assert.equal(native.tryLock(second), false, 'Second descriptor sees contention');
      native.unlock(second);
      assert.equal(probeInChild(), 'false', 'Another process sees contention after an unrelated unlock');
      assert.equal(readFileSync(lockPath, 'utf8'), '1234\n', 'Lock does not cover file contents');
      native.unlock(first);
      assert.equal(native.tryLock(second), true, 'Explicit unlock releases the lock');
    } finally {
      closeSync(second);
    }
    await assertLockReleased(first);
    native.unlock(first);
    assert.equal(probeInChild(), 'true', 'Child process can acquire a released lock');
    await assertLockReleased(first);
    native.unlock(first);
  } finally {
    closeSync(first);
  }

  for (const method of [native.tryLock, native.unlock]) {
    assert.throws(() => method('0'), TypeError);
    assert.throws(() => method(-1), RangeError);
    assert.throws(() => method(2 ** 30), error => error.code === 'EBADF' && Number.isInteger(error.errno));
  }
}

function windowsAcl(path, script) {
  const env = { ...process.env, JOB_APPLY_TEST_ACL_PATH: path };
  // Windows PowerShell must resolve its own modules when launched from PowerShell 7.
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === 'psmodulepath') delete env[name];
  }
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $path = $env:JOB_APPLY_TEST_ACL_PATH
    $acl = Get-Acl -LiteralPath $path
    ${script}
  `], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function describeAcl(path) {
  return JSON.parse(windowsAcl(path, `
    $sid = [System.Security.Principal.SecurityIdentifier]
    [PSCustomObject]@{
      current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      owner = $acl.GetOwner($sid).Value
      protected = $acl.AreAccessRulesProtected
      rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {
        [PSCustomObject]@{
          sid = $_.IdentityReference.Value
          inherited = $_.IsInherited
          kind = $_.AccessControlType.ToString()
        }
      })
    } | ConvertTo-Json -Depth 4 -Compress
  `));
}

function verifyAcl() {
  const directory = join(root, 'private');
  mkdirSync(directory);
  const existing = join(directory, 'existing.txt');
  writeFileSync(existing, 'existing');
  const existingAcl = describeAcl(existing);

  native.restrictToOwner(directory);
  assert.equal(native.isOwnerOnly(directory), true);
  const applied = describeAcl(directory);
  assert.equal(applied.owner, applied.current);
  assert.equal(applied.protected, true);
  assert.deepEqual(applied.rules, [{ sid: applied.current, inherited: false, kind: 'Allow' }]);
  assert.deepEqual(describeAcl(existing), existingAcl, 'Existing child ACLs are preserved');

  const nested = join(directory, 'nested');
  mkdirSync(nested);
  const child = join(nested, 'child.txt');
  writeFileSync(child, 'private');
  const inherited = describeAcl(child);
  assert.deepEqual(inherited.rules, [{ sid: applied.current, inherited: true, kind: 'Allow' }]);
  // An elevated token can assign its default group as owner even when it inherits an owner-only DACL.
  assert.equal(native.isOwnerOnly(child), inherited.owner === applied.current);
  native.restrictToOwner(child);
  assert.equal(native.isOwnerOnly(child), true);
  assert.equal(readFileSync(child, 'utf8'), 'private');

  windowsAcl(directory, `
    $group = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $group, 'ReadAndExecute', 'ContainerInherit, ObjectInherit', 'InheritOnly', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $acl
  `);
  assert.equal(native.isOwnerOnly(directory), false, 'A foreign inherit-only grant makes the ACL unsafe');
  native.restrictToOwner(directory);
  assert.equal(native.isOwnerOnly(directory), true);

  const junction = join(root, 'acl-junction');
  symlinkSync(directory, junction, 'junction');
  assert.throws(() => native.isOwnerOnly(junction), { code: 'ELOOP' });
  assert.throws(() => native.restrictToOwner(junction), { code: 'ELOOP' });
  assert.throws(() => native.isOwnerOnly(join(root, 'absent')), { code: 'ENOENT' });
  assert.throws(() => native.restrictToOwner(directory + '\0extra'), TypeError);
}

async function verifyIndependentScans(descriptor, names) {
  const barrier = new SharedArrayBuffer(12 * Int32Array.BYTES_PER_ELEMENT);
  const script = `
    const assert = require('node:assert/strict');
    const { workerData } = require('node:worker_threads');
    const { artifact, descriptor, names, barrier } = workerData;
    const native = require(artifact);
    const ready = new Int32Array(barrier);
    for (let index = 0; index < ready.length; index++) {
      if (Atomics.add(ready, index, 1) === 0) {
        assert.notEqual(Atomics.wait(ready, index, 1, 5_000), 'timed-out');
      } else {
        Atomics.notify(ready, index);
      }
      assert.deepEqual(native.listNames(descriptor).map(name => name.toString('utf8')).sort(), names);
    }
  `;
  const runs = Array.from({ length: 2 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(script, { eval: true, execArgv: [], workerData: { artifact, descriptor, names, barrier } });
    let failure;
    worker.on('error', error => { failure = error; });
    worker.once('exit', code => {
      if (code === 0 && !failure) resolve();
      else reject(failure ?? new Error(`Directory scan worker exited with code ${code}`));
    });
  }));
  for (const result of await Promise.allSettled(runs)) {
    if (result.status === 'rejected') throw result.reason;
  }
}

async function verifyDirectory() {
  const directory = join(root, 'reports');
  const moved = join(root, 'moved-reports');
  const target = join(root, 'junction-target');
  mkdirSync(directory);
  mkdirSync(target);
  const descriptor = openSync(directory, 'r');
  const regular = 'naïve-ü.md';
  try {
    assert.deepEqual(native.listNames(descriptor), []);
    writeFileSync(join(directory, regular), 'report');
    mkdirSync(join(directory, 'sub'));
    symlinkSync(target, join(directory, 'junction'), 'junction');
    const expected = ['junction', regular, 'sub'];
    for (let index = 0; index < 250; index++) {
      const name = `${index}-${'a'.repeat(140)}`;
      writeFileSync(join(directory, name), '');
      expected.push(name);
    }
    const names = () => native.listNames(descriptor).map(value => {
      assert.ok(Buffer.isBuffer(value));
      return value.toString('utf8');
    }).sort();
    assert.deepEqual(names(), expected.sort());
    assert.deepEqual(names(), expected, 'Repeated listings restart the directory scan');
    await verifyIndependentScans(descriptor, expected);
    assert.equal(native.inspect(descriptor, 'sub').mode, 0o040000);
    assert.equal(native.inspect(descriptor, 'junction').mode, 0o120000);
    assert.throws(() => native.openFile(descriptor, 'junction'), { code: 'ELOOP' });
    assert.throws(() => native.openFile(descriptor, 'sub'), { code: 'ENOTDIR' });
    for (const name of ['.', '..', 'a/b', 'a\\b', 'file:stream', 'file\0suffix']) {
      assert.throws(() => native.inspect(descriptor, name), TypeError);
      assert.throws(() => native.openFile(descriptor, name), TypeError);
    }
    assert.throws(() => native.inspect(descriptor, 'absent'), { code: 'ENOENT' });
    assert.throws(() => native.openFile(descriptor, 'absent'), { code: 'ENOENT' });

    renameSync(directory, moved);
    mkdirSync(directory);
    writeFileSync(join(directory, regular), 'replacement');
    assert.deepEqual(names(), expected);
    const metadata = native.inspect(descriptor, regular);
    assert.equal(metadata.mode, 0o100000);
    const opened = native.openFile(descriptor, regular);
    try {
      const stat = fstatSync(opened, { bigint: true });
      assert.equal(stat.dev, metadata.dev);
      assert.equal(stat.ino, metadata.ino);
      assert.equal(stat.size, metadata.size);
      assert.equal(readFileSync(opened, 'utf8'), 'report');
      assert.throws(() => native.listNames(opened), { code: 'ENOTDIR' });
    } finally {
      closeSync(opened);
    }
  } finally {
    closeSync(descriptor);
  }
}

const checks = { lock: verifyLock, acl: verifyAcl, directory: verifyDirectory };
if (!Object.hasOwn(checks, scenario)) {
  throw new Error('Expected a native Windows witness scenario');
}
await checks[scenario]();
