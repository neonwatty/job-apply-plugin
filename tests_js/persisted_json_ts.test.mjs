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

for (const executable of ['python3', 'python3.12', 'python3.13', 'python3.14']) {
  test(`persisted JSON chunks and strict UTF8 match Python: ${executable}`, (t) => {
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
  });
}
