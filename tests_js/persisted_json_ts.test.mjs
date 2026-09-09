import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { iterPersistedJson, encodePersistedUtf8 } from '../runtime/contracts/persisted-json.js';
import { parsePythonJson } from '../runtime/contracts/raw-json/parser.js';

function corpus() {
  let state = 711983;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const scalars = ['null', 'true', 'false', '0', '-0', '1.0', '-0.0', 'NaN', 'Infinity', '-Infinity',
    '5e-324', '1.7976931348623157e308', '9007199254740993', '1e16', '1e-5', '"λ😀"', '"\\ud800"', '"\\udc80"'];
  const value = (depth) => {
    if (depth === 0 || next() % 3 === 0) return scalars[next() % scalars.length];
    if (next() % 2) return `[${Array.from({ length: next() % 5 }, () => value(depth - 1)).join(',')}]`;
    const keys = ['"2"', '"1"', '"😀"', '"\\ue000"', '"__proto__"', '"\\ud800"', '"a"'];
    return `{${Array.from({ length: next() % 5 }, () => `${keys[next() % keys.length]}:${value(depth - 1)}`).join(',')}}`;
  };
  return [...scalars, '{}', '[]', '{"2":1,"1":2}', ...Array.from({ length: 192 }, () => value(4))];
}

function verifyPersisted(executable, t) {
    const inputs = corpus();
    const script = [
      'import json,platform,sys', 'rows=[]',
      'for raw in json.load(sys.stdin):',
      ' chunks=list(json.JSONEncoder(indent=2,sort_keys=True,ensure_ascii=False).iterencode(json.loads(raw)))',
      ' try: encoded={"hex":"".join(chunks).encode("utf-8").hex()}',
      ' except UnicodeEncodeError: encoded={"error":"UnicodeEncodeError"}',
      ' rows.append({"chunks":chunks,"encoded":encoded})',
      'print(json.dumps({"python":platform.python_version(),"rows":rows},ensure_ascii=True))',
    ].join('\n');
    const run = spawnSync(executable, ['-I', '-c', script], { input: JSON.stringify(inputs), encoding: 'utf8',
      timeout: 10000, maxBuffer: 2 ** 22 });
    if (run.error?.code === 'ENOENT' && executable !== 'python3') return t.skip('Interpreter alias unavailable');
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    const profile = receipt.python.split('.').slice(0, 2).join('.');
    if (executable !== 'python3') assert.equal(profile, executable.slice(6));
    assert.equal(receipt.rows.length, inputs.length);
    for (let index = 0; index < inputs.length; index += 1) {
      const value = parsePythonJson(inputs[index], { intMaxStrDigits: 4300 });
      const chunks = [...iterPersistedJson(value, { pathProfile: profile, intMaxStrDigits: 4300 })];
      assert.deepEqual(chunks, receipt.rows[index].chunks, inputs[index]);
      const expected = receipt.rows[index].encoded;
      if (expected.error) assert.throws(() => encodePersistedUtf8(chunks.join('')), error => error.name === expected.error);
      else assert.equal(encodePersistedUtf8(chunks.join('')).toString('hex'), expected.hex);
    }
    t.diagnostic(`${receipt.python}: ${inputs.length} deterministic typed values; seed 711983`);
}

test('persisted JSON chunks and strict UTF8 match Python: python3', t => verifyPersisted('python3', t));
test('persisted JSON chunks and strict UTF8 match Python: python3.12', t => verifyPersisted('python3.12', t));
test('persisted JSON chunks and strict UTF8 match Python: python3.13', t => verifyPersisted('python3.13', t));
test('persisted JSON chunks and strict UTF8 match Python: python3.14', t => verifyPersisted('python3.14', t));

import { rm, readFile, readdir } from 'node:fs/promises';
import { PythonText, PythonUnicodeEncodeError } from '../runtime/contracts/python-text.js';
import { PythonObject } from '../runtime/contracts/python-object.js';
import { atomicWriteJson } from '../runtime/store/atomic-write-json.js';
import { iterPersistedPointJson, encodePersistedPointUtf8, atomicWritePointJson,
  pointExceptionFacts, describePointException, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';
import { pointProfiles, pointVectors, pointPayload, pointError, pointFixture, pointAtomicIO,
  pointFileState, withoutPointAtime, pointText, pointInteger, pointObject, pointFault, withPointNativeFaults } from './atomic_write_json_ts_support.mjs';

const optionsFor = (profile, limit = 640) => ({ pathProfile: profile, intMaxStrDigits: limit });
function collectPoint(value, options, encode) {
  const chunks = [], successfulHex = []; let failure;
  try {
    for (const text of iterPersistedPointJson(value, options)) {
      chunks.push([...text.codePoints]);
      if (encode) {
        try { successfulHex.push(encodePersistedPointUtf8(text).toString('hex')); }
        catch (error) { assert.equal(error.object, text); throw error; }
      }
    }
  } catch (error) { failure = error; }
  return encode ? { yieldedPoints: chunks, successfulHex, error: pointError(failure) }
    : { chunksPoints: chunks, error: pointError(failure) };
}

test('S04 point persisted chunks preserve explicit codepoints and profile order', async () => {
  const vectors = await pointVectors();
  const cases = vectors.chunks.filter(row => row.id !== 'chunk-invalid-key');
  assert.equal(cases.length, 17);
  for (const profile of pointProfiles) for (const row of cases) {
    const options = optionsFor(profile, row.intMaxStrDigits);
    assert.deepEqual(collectPoint(pointPayload(row.id), options, false), row.profiles[profile].serializer, `${profile} ${row.id} serializer`);
    assert.deepEqual(collectPoint(pointPayload(row.id), options, true), row.profiles[profile].strictUtf8, `${profile} ${row.id} encode`);
  }
});

test('S04 point atomic writes preserve native chunk failures and cleanup context', async t => {
  const vectors = await pointVectors(); assert.equal(vectors.atomic.length, 10);
  for (const profile of pointProfiles) for (const row of vectors.atomic) {
    const fixture = await pointFixture();
    const faults = Object.fromEntries(row.faults.map(fault => [fault.stage, pointFault(fault.stage)]));
    const { io, state } = pointAtomicIO(fixture, profile, faults);
    try {
      let failure;
      try { await atomicWritePointJson(fixture.target, pointPayload(row.id), optionsFor(profile, row.intMaxStrDigits), io); }
      catch (error) { failure = error; }
      const target = await pointFileState(fixture.target), parent = await pointFileState(fixture.parent);
      const sentinel = await pointFileState(fixture.sentinel);
      let temporary = null;
      if (state.temporary !== null) {
        try { temporary = await pointFileState(state.temporary); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      t.diagnostic(JSON.stringify({ id: row.id, profile, before: fixture.before,
        after: { target, parent, sentinel }, postClose: state.postClose, temporary },
      (key, value) => key === 'contentHex' ? undefined : value));
      assert.deepEqual(pointError(failure), row.error, `${profile} ${row.id}`);
      // Python fileno is internal to the port's sync method, not a separate IO call.
      assert.deepEqual(state.events, row.productionEvents.filter(event => event !== 'temporary.fileno'), row.id);
      const writes = state.writes.slice(0, row.writeChunksPoints.length);
      assert.deepEqual(writes.map(write => write.points), row.writeChunksPoints);
      assert.deepEqual(writes.map(write => write.result), row.expectedWriteResults);
      assert.deepEqual(state.writes.map(write => write.visibleHex), row.expectedVisibleHexAfterEachWrite);
      assert.deepEqual(writes.filter(write => !write.error).map(write => encodePersistedPointUtf8(write.text).toString('hex')), row.successfulWriteHex);
      for (const write of writes.filter(write => write.error?.name === 'UnicodeEncodeError')) assert.equal(write.error.object, write.text);
      if (row.finalLfWrite) assert.deepEqual(state.writes.at(-1).points, row.finalLfWrite.points);
      else assert.equal(state.writes.length, row.writeChunksPoints.length);
      assert.equal(state.postClose.contentHex, row.expectedPostCloseTempHex);
      assert.equal(state.postClose.mode, 0o600);
      assert.equal(target.contentHex, row.targetHex); assert.equal(target.mode, row.targetMode);
      assert.equal(parent.kind, 'directory'); assert.equal(parent.mode, row.parentMode); assert.equal(parent.ino, fixture.before.parent.ino);
      assert.deepEqual(withoutPointAtime(sentinel), withoutPointAtime(fixture.before.sentinel));
      if (row.targetHex === vectors.recipes.baselineTargetHex) assert.deepEqual(withoutPointAtime(target), withoutPointAtime(fixture.before.target));
      else assert.equal(target.ino, state.postClose.ino);
      const names = await readdir(fixture.parent);
      assert.equal(names.length, row.expectedFinalTemp === 'regular-file' ? 2 : 1);
      if (row.expectedFinalTemp === 'regular-file') assert.deepEqual(withoutPointAtime(temporary), withoutPointAtime(state.postClose));
      else await assert.rejects(readFile(state.temporary), { code: 'ENOENT' });
      if (state.events.includes('temporary.unlink')) assert.equal(state.unlinkBefore, row.expectedPostCloseTempHex);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test('S04 point persistence preserves explicit causes and reused exception identity', async () => {
  const original = new Error('explicit origin'), opaque = { marker: 1 };
  for (const [descriptor, cause, suppression] of [
    [{}, null, false], [{ cause: null }, null, true], [{ cause: opaque }, opaque, true],
    [{ cause: original, suppressContext: false }, original, false], [{ suppressContext: true }, null, true],
  ]) {
    const error = new Error('owned'); describePointException(error, descriptor);
    const first = pointExceptionFacts(error), second = pointExceptionFacts(error);
    assert.equal(first.cause, cause); assert.equal(first.suppressContext, suppression); assert.equal(first.context, null);
    assert.notEqual(first, second); assert.ok(Object.isFrozen(first)); assert.equal(Object.isFrozen(error), false);
  }
  const inherited = new Error('existing', { cause: original }); describePointException(inherited, {});
  assert.equal(pointExceptionFacts(inherited).cause, original); assert.equal(pointExceptionFacts(inherited).suppressContext, true);
  for (const descriptor of [null, [], { extra: true }, { suppressContext: 1 }, { suppressContext: undefined },
    { [Symbol('unknown')]: true }, { get cause() { assert.fail('must not invoke descriptor getter'); } }]) {
    assert.throws(() => describePointException(new Error('bad'), descriptor), TypeError);
  }
  assert.throws(() => pointExceptionFacts('not an Error'), TypeError);
  const ownedUnicode = (() => {
    try { encodePersistedPointUtf8(pointText([55296])); } catch (error) { return error; }
  })();
  const originalObject = ownedUnicode.object;
  describePointException(ownedUnicode, { cause: original });
  for (const profile of pointProfiles) {
    for (const stage of ['stat', 'write']) {
      const fixture = await pointFixture(), first = new Error(stage), close = new Error('native close', { cause: original });
      const unlink = new Error('native unlink', { cause: opaque });
      try {
        await withPointNativeFaults(fixture, { [stage]: first, close, ...(stage === 'stat' ? { unlink } : {}) }, async events => {
          const io = createNativePointAtomicWriteIO(profile);
          let failure;
          try {
            const handle = await io.createTemporary({ directory: fixture.parent, prefix: '.document.json.', suffix: '.tmp' });
            await handle.write(PythonText.fromJavaScript('pending'));
            await handle.close();
          } catch (error) { failure = error; }
          assert.equal(failure, stage === 'stat' ? unlink : close);
          assert.equal(pointExceptionFacts(close).context, first); assert.equal(close.cause, original);
          if (stage === 'stat') {
            assert.equal(pointExceptionFacts(unlink).context, close); assert.equal(unlink.cause, opaque);
            assert.deepEqual(events, ['native-stat', 'native-close', 'native-unlink']);
          } else assert.deepEqual(events, ['native-stat', 'native-write', 'native-close']);
        });
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
    const fixture = await pointFixture(), a = new Error('A', { cause: original }), b = new Error('B');
    try {
      const { io } = pointAtomicIO(fixture, profile, { write: a, close: b, unlink: a });
      await assert.rejects(atomicWritePointJson(fixture.target, pointPayload('atomic-scalar'), optionsFor(profile), io), error => error === a);
      assert.equal(pointExceptionFacts(a).context, b); assert.equal(pointExceptionFacts(b).context, null);
      assert.equal(a.cause, original); assert.equal(pointExceptionFacts(a).cause, original);
      const sync = new Error('sync'), close = new Error('close', { cause: original });
      const second = pointAtomicIO(fixture, profile, { 'directory-sync': sync, 'directory-close': close });
      await assert.rejects(atomicWritePointJson(fixture.target, pointPayload('atomic-scalar'), optionsFor(profile), second.io), error => error === close);
      assert.equal(pointExceptionFacts(close).context, sync); assert.equal(close.cause, original);
      assert.equal(pointExceptionFacts(close).suppressContext, true);
      assert.equal((await readFile(fixture.target)).toString('hex'), (await pointVectors()).atomic[0].targetHex);
      const swallowed = pointAtomicIO(fixture, profile, { 'directory-sync': pointFault('directory-sync') });
      await atomicWritePointJson(fixture.target, pointPayload('atomic-scalar'), optionsFor(profile), swallowed.io);
      assert.ok(swallowed.state.events.includes('os.close(parent)'));
      // The legacy facade still uses Error.cause for implicit context.
      const legacySync = new Error('legacy sync'), legacyClose = new Error('legacy close');
      const legacyIO = pointAtomicIO(fixture, profile, { 'directory-sync': legacySync, 'directory-close': legacyClose });
      const create = legacyIO.io.createTemporary;
      legacyIO.io.createTemporary = async options => {
        const handle = await create(options);
        return { ...handle, write: text => handle.write(PythonText.fromJavaScript(text)) };
      };
      await assert.rejects(atomicWriteJson(fixture.target, new Map([['a', 'x']]), optionsFor(profile), legacyIO.io), error => error === legacyClose);
      assert.equal(legacyClose.cause, legacySync);
      const reused = pointAtomicIO(fixture, profile, { write: new Error('prior'), close: ownedUnicode });
      await assert.rejects(atomicWritePointJson(fixture.target, pointPayload('atomic-scalar'), optionsFor(profile), reused.io), error => error === ownedUnicode);
      assert.equal(ownedUnicode.object, originalObject); assert.equal(pointExceptionFacts(ownedUnicode).unicode.object, originalObject);
      assert.equal(pointExceptionFacts(ownedUnicode).cause, original);
      const nonError = pointAtomicIO(fixture, profile, { write: 'thrown value', close: new Error('cleanup') });
      let final;
      try { await atomicWritePointJson(fixture.target, pointPayload('atomic-scalar'), optionsFor(profile), nonError.io); }
      catch (error) { final = error; }
      assert.equal(pointExceptionFacts(final).context, 'thrown value');
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test('S04 point persistence rejects forged inputs and preserves legacy mixed-key boundaries', () => {
  class HostileText extends PythonText {
    get codePoints() { throw new Error('virtual codePoints'); }
    get length() { throw new Error('virtual length'); }
    encodeUtf8() { throw new Error('virtual encode'); }
    contentKey() { throw new Error('virtual key'); }
    compare() { throw new Error('virtual compare'); }
  }
  class HostileObject extends PythonObject {
    get size() { throw new Error('virtual size'); }
    entries() { throw new Error('virtual entries'); }
    get() { throw new Error('virtual get'); }
  }
  const bad = new HostileText([55296, 56320]);
  assert.throws(() => encodePersistedPointUtf8(bad), error => {
    assert.ok(error instanceof PythonUnicodeEncodeError); assert.equal(error.object, bad);
    assert.deepEqual(pointError(error).objectPoints, [55296, 56320]); return true;
  });
  const object = new HostileObject(); PythonObject.prototype.set.call(object, PythonText.fromJavaScript('a'), new HostileText([65536]));
  for (const profile of pointProfiles) {
    assert.equal([...iterPersistedPointJson(object, optionsFor(profile))].map(chunk => encodePersistedPointUtf8(chunk).toString()).join(''), '{\n  "a": "𐀀"\n}');
    for (const forged of [Object.create(PythonText.prototype), Object.create(PythonObject.prototype), new Map([['a', 'b']])]) {
      assert.throws(() => [...iterPersistedPointJson(forged, optionsFor(profile))], TypeError);
    }
    assert.throws(() => encodePersistedPointUtf8(Object.create(PythonText.prototype)), TypeError);
    const iterator = iterPersistedJson(new Map([['a', pointInteger('1')], [1, pointInteger('2')]]), optionsFor(profile));
    const prefix = []; let failure;
    try { for (const chunk of iterator) prefix.push(chunk); } catch (error) { failure = error; }
    assert.deepEqual(prefix, profile === '3.12' ? ['{', '\n  '] : ['{']);
    assert.equal(failure.name, 'TypeError'); assert.equal(failure.message, 'Persisted JSON object keys must be strings');
    const map = new Map([['a', 'old']]), lazy = iterPersistedJson(map, optionsFor(profile));
    const head = [lazy.next().value, lazy.next().value, lazy.next().value, lazy.next().value];
    map.set('a', 'new'); assert.equal([...head, ...lazy].join(''), '{\n  "a": "new"\n}');
    const array = [new Map([['a', 'old']])], steps = iterPersistedJson(array, optionsFor(profile));
    assert.equal(steps.next().value, '[\n  '); array[0] = new Map([['b', 'new']]);
    const first = steps.next().value; array.push('added');
    assert.equal('[\n  ' + first + [...steps].join(''), '[\n  {\n    "b": "new"\n  },\n  "added"\n]');
    const removing = ['first', 'removed'], removeSteps = iterPersistedJson(removing, optionsFor(profile));
    const opening = removeSteps.next().value; removing.pop(); assert.equal(opening + [...removeSteps].join(''), '[\n  "first"\n]');
    const captured = pointObject([['a', PythonText.fromJavaScript('old')]]), pointSteps = iterPersistedPointJson(captured, optionsFor(profile));
    const parts = [pointSteps.next().value, pointSteps.next().value, pointSteps.next().value, pointSteps.next().value];
    captured.set(PythonText.fromJavaScript('a'), PythonText.fromJavaScript('new'));
    assert.equal([...parts, ...pointSteps].map(chunk => encodePersistedPointUtf8(chunk).toString()).join(''), '{\n  "a": "old"\n}');
  }
});
