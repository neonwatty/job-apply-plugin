import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { encodeJsonlJson } from '../runtime/contracts/jsonl-json.js';
import { parsePythonJson } from '../runtime/contracts/raw-json/parser.js';

function corpus() {
  let state = 819171;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const atoms = ['null', 'true', 'false', '-0', '-0.0', '1.0', 'NaN', 'Infinity', '-Infinity', '5e-324',
    '1.7976931348623157e308', '9007199254740993', '"line\\n  text"', '"λ😀"', '"\\ud800"', '"\\udc80"', '"\\t\\u0000"'];
  function value(depth) {
    if (depth === 0 || next() % 3 === 0) return atoms[next() % atoms.length];
    const values = Array.from({ length: next() % 4 }, () => value(depth - 1));
    return next() % 2 ? `[${values.join(',')}]` : `{${values.map((value, index) => `${JSON.stringify(['😀', '\ue000', '2'][index])}:${value}`).join(',')}}`;
  }
  return [...atoms, '{}', '[]', '{"z":{},"a":[[],{},[1]]}', ...Array.from({ length: 192 }, () => value(4))];
}

function verifyJsonl(executable, t) {
    const inputs = corpus();
    const script = [
      'import json,sys,platform', 'rows=[]',
      'for raw in json.load(sys.stdin):',
      ' try:rows.append({"hex":(json.dumps(json.loads(raw),sort_keys=True,ensure_ascii=False)+"\\n").encode("utf-8").hex()})',
      ' except Exception as error:rows.append({"error":type(error).__name__})',
      'print(json.dumps({"python":platform.python_version(),"rows":rows}))',
    ].join('\n');
    const run = spawnSync(executable, ['-I', '-c', script], { input: JSON.stringify(inputs), encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    const profile = receipt.python.split('.').slice(0, 2).join('.');
    if (executable !== 'python3') assert.equal(profile, executable.slice(6));
    assert.equal(receipt.rows.length, inputs.length);
    inputs.forEach((raw, index) => {
      const value = parsePythonJson(raw, { intMaxStrDigits: 4300 });
      const expected = receipt.rows[index];
      const encode = () => encodeJsonlJson(value, { pathProfile: profile, intMaxStrDigits: 4300 });
      if (expected.error) assert.throws(encode, error => error.name === expected.error, raw);
      else assert.equal(encode().toString('hex'), expected.hex, raw);
    });
    t.diagnostic(`${receipt.python}: ${inputs.length} deterministic typed values; seed819171`);
}

test('JSONL bytes match actual Python default spacing and strict UTF8: python3', t => verifyJsonl('python3', t));
test('JSONL bytes match actual Python default spacing and strict UTF8: python3.12', t => verifyJsonl('python3.12', t));
test('JSONL bytes match actual Python default spacing and strict UTF8: python3.13', t => verifyJsonl('python3.13', t));
test('JSONL bytes match actual Python default spacing and strict UTF8: python3.14', t => verifyJsonl('python3.14', t));

import { rm, readFile } from 'node:fs/promises';
import { PythonText } from '../runtime/contracts/python-text.js';
import { PythonObject } from '../runtime/contracts/python-object.js';
import { appendHistoryEvent } from '../runtime/store/jsonl-history.js';
import { encodePointJsonlJson, appendPointHistoryEvent, pointExceptionFacts,
  describePointException } from '../runtime/store/point-persistence.js';
import { pointProfiles, pointVectors, pointPayload, pointError, pointFixture,
  pointFileState, withoutPointAtime, pointFault, pointObject, pointText } from './atomic_write_json_ts_support.mjs';
import { pointHistoryIO } from './jsonl_history_support.mjs';
const pointOptions = profile => ({ pathProfile: profile, intMaxStrDigits: 640 });

test('S04 point JSONL preserves complete serialization before strict encoding', async () => {
  const vectors = await pointVectors();
  for (const profile of pointProfiles) for (const row of vectors.jsonl.filter(row => row.gateResult === false)) {
    let encoded, failure;
    try { encoded = encodePointJsonlJson(pointPayload(row.id), pointOptions(profile)); }
    catch (error) { failure = error; }
    assert.deepEqual(pointError(failure), row.error, `${profile} ${row.id}`);
    if (encoded) assert.equal(encoded.toString('hex'), row.appendedHex);
    if (failure?.name === 'UnicodeEncodeError') {
      assert.deepEqual([...failure.object.codePoints], row.linePoints);
      assert.equal(failure.object.codePoints.at(-1), 10);
      const facts = pointExceptionFacts(failure);
      assert.equal(facts.unicode.object, failure.object); assert.ok(Object.isFrozen(facts.unicode));
    }
  }
});

test('S04 point JSONL native append preserves gate identity and unopened failures', async t => {
  const vectors = await pointVectors(); assert.equal(vectors.jsonl.length, 8);
  for (const profile of pointProfiles) for (const row of vectors.jsonl) {
    const fixture = await pointFixture(), observer = pointHistoryIO(fixture.target, profile, {}, true);
    const event = pointPayload(row.id), gateError = pointFault('gate'); let gateCalls = 0, failure;
    try {
      try {
        await appendPointHistoryEvent(fixture.target, event, {
          serialization: pointOptions(profile), io: observer.io,
          async isIdempotent(value) {
            gateCalls++; assert.equal(value, event); assert.deepEqual(observer.calls, []);
            if (row.gateResult === null) throw gateError;
            return row.gateResult;
          },
        });
      } catch (error) { failure = error; }
      const target = await pointFileState(fixture.target), parent = await pointFileState(fixture.parent);
      const sentinel = await pointFileState(fixture.sentinel);
      t.diagnostic(JSON.stringify({ id: row.id, profile, before: fixture.before, after: { target, parent, sentinel } },
        (key, value) => key === 'contentHex' ? undefined : value));
      assert.equal(gateCalls, 1); assert.deepEqual(pointError(failure), row.error, `${profile} ${row.id}`);
      if (row.gateResult === null) assert.equal(failure, gateError);
      if (row.appendedHex) {
        assert.equal(observer.calls[0], 'open'); assert.equal(observer.calls[1], 'stat');
        assert.deepEqual(observer.calls.slice(-3), ['sync', 'close', 'chmod']);
        const line = Buffer.from(row.appendedHex, 'hex'); let offset = 0;
        for (const write of observer.writes) {
          assert.deepEqual(write.requested, line.subarray(offset));
          assert.ok(write.result > 0 && write.result <= write.requested.length); offset += write.result;
        }
        assert.equal(offset, line.length);
        assert.deepEqual(observer.calls, ['open', 'stat', ...observer.writes.map(() => 'write'), 'sync', 'close', 'chmod']);
      } else assert.deepEqual(observer.calls, []);
      assert.equal(target.contentHex, row.targetHex); assert.equal(target.mode, row.targetMode); assert.equal(target.ino, fixture.before.target.ino);
      if (!row.appendedHex) assert.deepEqual(withoutPointAtime(target), withoutPointAtime(fixture.before.target));
      assert.equal(parent.kind, 'directory'); assert.equal(parent.mode, 0o700); assert.equal(parent.ino, fixture.before.parent.ino);
      assert.deepEqual(withoutPointAtime(sentinel), withoutPointAtime(fixture.before.sentinel));
    } finally { await observer.cleanup(); await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test('S04 point JSONL preserves explicit causes through rollback and close', async () => {
  for (const profile of pointProfiles) for (const mode of ['rollback', 'truncate', 'rollback-sync', 'stat', 'reused', 'non-error']) {
    const fixture = await pointFixture(), cause = new Error('explicit cause');
    const write = mode === 'non-error' ? 'opaque thrown write' : new Error('write failure');
    const rollback = new Error('rollback failure'), close = mode === 'reused' ? write : new Error('close failure', { cause });
    const faults = mode === 'stat' ? { stat: write } : { 'second-write': write };
    if (mode === 'truncate' || mode === 'reused') faults.truncate = rollback;
    if (mode === 'rollback-sync') faults['rollback-sync'] = rollback;
    if (!['stat', 'non-error', 'rollback'].includes(mode)) faults.close = close;
    if (close instanceof Error) describePointException(close, { cause, suppressContext: false });
    const observer = pointHistoryIO(fixture.target, profile, faults, true);
    try {
      let failure;
      try { await appendPointHistoryEvent(fixture.target, pointPayload('jsonl-scalar'), {
        serialization: pointOptions(profile), io: observer.io, isIdempotent: async () => false,
      }); } catch (error) { failure = error; }
      if (mode === 'stat') {
        assert.equal(failure, write); assert.deepEqual(observer.calls, ['open', 'stat']);
        assert.equal(observer.handles.size, 1, 'initial stat failure does not invent close');
      } else {
        const expectedCalls = ['open', 'stat', 'write', 'write', 'truncate'];
        if (!['truncate', 'reused'].includes(mode)) expectedCalls.push('rollback-sync');
        expectedCalls.push('close'); assert.deepEqual(observer.calls, expectedCalls);
        if (mode === 'rollback' || mode === 'non-error') assert.equal(failure, write);
        else {
          assert.equal(failure, close); const facts = pointExceptionFacts(close);
          assert.equal(facts.cause, cause); assert.equal(facts.suppressContext, false);
          assert.equal(facts.context, rollback);
          assert.equal(pointExceptionFacts(rollback).context, mode === 'reused' ? null : write);
          if (mode !== 'reused') assert.equal(close.cause, cause);
        }
      }
      const expected = ['truncate', 'reused'].includes(mode) ? '{}\n{"a' : '{}\n';
      assert.equal((await readFile(fixture.target)).toString(), expected);
      assert.deepEqual(withoutPointAtime(await pointFileState(fixture.sentinel)), withoutPointAtime(fixture.before.sentinel));
    } finally { await observer.cleanup(); await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test('S04 point persistence entrypoints leave legacy values and public parser behavior unchanged', async () => {
  const options = pointOptions('3.14');
  const legacy = parsePythonJson('{"a":"x","n":1}', { intMaxStrDigits: 640 });
  assert.ok(legacy instanceof Map); assert.equal(typeof legacy.get('a'), 'string');
  assert.equal(legacy.get('n').kind, 'int');
  assert.equal(encodeJsonlJson(legacy, options).toString(), '{"a": "x", "n": 1}\n');
  assert.throws(() => encodePointJsonlJson(legacy, options), TypeError);
  assert.throws(() => encodeJsonlJson(pointObject([['a', pointText([120])]]), options), TypeError);
  for (const input of [Object.create(PythonText.prototype), Object.create(PythonObject.prototype)]) {
    assert.throws(() => encodePointJsonlJson(input, options), TypeError);
  }
  const fixture = await pointFixture();
  try {
    const write = new Error('legacy write'), close = new Error('legacy close');
    const observer = pointHistoryIO(fixture.target, '3.14', { 'second-write': write, close }, true);
    try {
      await assert.rejects(appendHistoryEvent(fixture.target, legacy, {
        serialization: options, io: observer.io, isIdempotent: async event => { assert.equal(event, legacy); return false; },
      }), error => error === close);
      assert.equal(close.cause, write); assert.equal(pointExceptionFacts(close).context, null);
      assert.equal((await readFile(fixture.target)).toString(), '{}\n');
    } finally { await observer.cleanup(); }
    // A gate hit receives the original invalid value and precedes validation.
    for (const event of [legacy, Object.create(PythonObject.prototype)]) {
      let gates = 0;
      await appendPointHistoryEvent(fixture.target, event, { serialization: options,
        isIdempotent: async value => { gates++; assert.equal(value, event); return true; },
        io: { open() { assert.fail('gate hit must not open'); } },
      });
      assert.equal(gates, 1);
    }
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
