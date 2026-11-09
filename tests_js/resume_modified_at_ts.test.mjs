import { nativeStatTimeMode } from './resume_stat_profile_support.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resumeModifiedAt } from '../runtime/store/resume-modified-at.js';
import { statSecondsFromNanoseconds } from '../runtime/contracts/stat-time.js';

const primary = process.platform === 'win32' ? 'python' : 'python3';
const reference = fileURLToPath(new URL('../tools/contracts/resume-modified-at/reference.py', import.meta.url));
const decode = (hex) => Buffer.from(hex, 'hex').readDoubleBE();
function observe(seconds) {
  try { return { kind: 'value', value: resumeModifiedAt(seconds) }; }
  catch (error) { return { kind: 'error', name: error.name }; }
}

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`stat time explicit modes match independent exact arithmetic: ${executable}`, (t) => {
    const seconds = [-(1n << 63n), -(1n << 63n) + 1n, -(1n << 53n) - 1n,
      -(1n << 53n), -2n, -1n, 0n, 1n, 1767225600n, (1n << 53n) - 1n,
      1n << 53n, (1n << 53n) + 1n, (1n << 63n) - 2n, (1n << 63n) - 1n];
    const corpus = seconds.flatMap((second) => [0n, 1n, 499n, 500n, 600n,
      999999400n, 999999500n, 999999999n].map((remainder) => String(second * 1000000000n + remainder)));
    const script = [
      'import decimal,json,platform,struct,sys',
      'decimal.getcontext().prec=200',
      'D=decimal.Decimal.from_float',
      'bits=lambda value:struct.pack(">d",value).hex()',
      'rows=[]',
      'for text in json.load(sys.stdin):',
      ' seconds,remainder=divmod(int(text),10**9)',
      ' rounded_seconds=float(seconds)',
      ' exact=D(rounded_seconds)+D(1e-9)*decimal.Decimal(remainder)',
      ' product=1e-9*float(remainder)',
      ' rows.append([bits(float(exact)),bits(rounded_seconds+product)])',
      'print(json.dumps({"python":platform.python_version(),"rows":rows}))',
    ].join('\n');
    const run = spawnSync(executable, ['-I', '-c', script], {
      input: JSON.stringify(corpus), encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024,
    });
    if (run.error?.code === 'ENOENT' && executable !== primary) { t.skip('Interpreter alias unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    if (executable !== primary) assert.ok(receipt.python.startsWith(executable.replace('python', '') + '.'));
    assert.equal(receipt.rows.length, corpus.length);
    let differentModes = 0;
    receipt.rows.forEach((row, index) => {
      if (row[0] !== row[1]) differentModes += 1;
      for (const [column, mode] of ['fused', 'separate'].entries()) {
        const encoded = Buffer.alloc(8);
        encoded.writeDoubleBE(statSecondsFromNanoseconds(BigInt(corpus[index]), mode));
        assert.equal(encoded.toString('hex'), row[column], `${mode}: ${corpus[index]}`);
      }
    });
    assert.ok(differentModes > 0, 'Corpus must distinguish arithmetic modes');
    t.diagnostic(`${receipt.python}: ${corpus.length} exact arithmetic cases, ${differentModes} distinguish modes`);
  });
}

test('stat time rejects unknown modes and seconds outside signed 64-bit range', () => {
  for (const mode of [undefined, null, '', 'native', 'FUSED', 0, {}]) {
    assert.throws(() => statSecondsFromNanoseconds(0n, mode), TypeError);
  }
  const minimum = -(1n << 63n) * 1000000000n;
  const exclusiveMaximum = (1n << 63n) * 1000000000n;
  for (const mode of ['fused', 'separate']) {
    for (const ns of [minimum - 1n, minimum - 1000000000n, exclusiveMaximum, exclusiveMaximum + 1n]) {
      assert.throws(() => statSecondsFromNanoseconds(ns, mode), RangeError);
    }
    assert.doesNotThrow(() => statSecondsFromNanoseconds(minimum, mode));
    assert.doesNotThrow(() => statSecondsFromNanoseconds(exclusiveMaximum - 1n, mode));
  }
});
function generatedHex() {
  const cases = new Set();
  const buffer = Buffer.alloc(8);
  for (const seconds of [-62135596800, 253402300800, -1, 0, 1, -0.0000005, 0.9999995, 1767225600.9999995]) {
    buffer.writeDoubleBE(seconds);
    const bits = buffer.readBigUInt64BE();
    for (let step = -32n; step <= 32n; step += 1n) {
      if (bits + step < 0n || bits + step > 0xffffffffffffffffn) continue;
      buffer.writeBigUInt64BE(bits + step); cases.add(buffer.toString('hex'));
    }
  }
  let state = 0x53da9;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let index = 0; index < 2048; index += 1) {
    buffer.writeUInt32BE(next(), 0); buffer.writeUInt32BE(next(), 4);
    cases.add(buffer.toString('hex'));
  }
  // Ordinary epoch seconds concentrate evidence on useful representable dates.
  for (let index = 0; index < 512; index += 1) {
    buffer.writeDoubleBE((next() / 0xffffffff) * 315537897599 - 62135596800);
    cases.add(buffer.toString('hex'));
  }
  return [...cases];
}

for (const executable of [primary, 'python3.12', 'python3.13', 'python3.14']) {
  test(`resume timestamp TS matches fixed and generated Python seconds: ${executable}`, (t) => {
    const run = spawnSync(executable, ['-I', reference], { input: '', encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 });
    if (run.error?.code === 'ENOENT' && executable !== primary) { t.skip('Interpreter alias unavailable'); return; }
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    if (executable !== primary) assert.ok(receipt.profile.python.startsWith(executable.replace('python', '') + '.'));
    assert.equal(receipt.cases.length, 24);
    assert.equal(receipt.nativeCases.length, 4);
    const nativeMode = nativeStatTimeMode(receipt.nativeCases);
    for (const item of receipt.cases) assert.deepEqual(observe(decode(item.secondsHex)), item.outcome, item.id);
    for (const item of receipt.nativeCases) {
      assert.equal(item.unchanged, true);
      assert.equal(resumeModifiedAt(decode(item.secondsHex)), item.value);
      const encoded = Buffer.alloc(8);
      encoded.writeDoubleBE(statSecondsFromNanoseconds(BigInt(item.actualNs), nativeMode));
      assert.equal(encoded.toString('hex'), item.secondsHex, `native conversion ${item.actualNs}`);
    }
    const generated = generatedHex();
    const script = [
      'import json,sys,struct', 'from types import SimpleNamespace',
      'sys.path.insert(0,"scripts")', 'from job_apply_store.normalization import _resume_modified_at',
      'results=[]', 'for value in json.load(sys.stdin):',
      ' try: results.append({"kind":"value","value":_resume_modified_at(SimpleNamespace(st_mtime=struct.unpack(">d",bytes.fromhex(value))[0]))})',
      ' except Exception as error: results.append({"kind":"error","name":type(error).__name__})',
      'print(json.dumps(results))',
    ].join('\n');
    const oracle = spawnSync(executable, ['-I', '-c', script], { input: JSON.stringify(generated), encoding: 'utf8', timeout: 10000, maxBuffer: 512 * 1024 });
    assert.equal(oracle.status, 0, oracle.stderr);
    const outcomes = JSON.parse(oracle.stdout);
    assert.equal(outcomes.length, generated.length);
    generated.forEach((hex, index) => assert.deepEqual(observe(decode(hex)), outcomes[index], hex));
    const nativeTimes = [];
    for (const seconds of [-2n, -1n, 0n, 1n, 1767225600n]) {
      for (const nanos of [0n, 1n, 499n, 500n, 501n, 600n, 999999400n, 999999500n, 999999600n, 999999999n]) {
        nativeTimes.push(String(seconds * 1000000000n + nanos));
      }
    }
    const nativeScript = [
      'import json,sys,os,tempfile,struct', 'from pathlib import Path', 'rows=[]',
      'with tempfile.TemporaryDirectory(prefix="ts-time-native-oracle-") as root:',
      ' path=Path(root)/"synthetic"; path.write_bytes(b"synthetic")',
      ' for text in json.load(sys.stdin):',
      '  ns=int(text);os.utime(path,ns=(ns,ns));info=path.stat()',
      '  rows.append([str(info.st_mtime_ns),struct.pack(">d",info.st_mtime).hex()])',
      'print(json.dumps(rows))',
    ].join('\n');
    const native = spawnSync(executable, ['-I', '-c', nativeScript], { input: JSON.stringify(nativeTimes), encoding: 'utf8', timeout: 5000 });
    assert.equal(native.status, 0, native.stderr);
    const nativeRows = JSON.parse(native.stdout);
    assert.equal(nativeRows.length, 50);
    for (const [actualNs, secondsHex] of nativeRows) {
      const encoded = Buffer.alloc(8);
      encoded.writeDoubleBE(statSecondsFromNanoseconds(BigInt(actualNs), nativeMode));
      assert.equal(encoded.toString('hex'), secondsHex, `native st_mtime ${actualNs}`);
    }
    t.diagnostic(`${receipt.profile.python}: 24 fixed, 4 native seconds values, ${generated.length} generated binary64 values; seed 343465`);
  });
}
