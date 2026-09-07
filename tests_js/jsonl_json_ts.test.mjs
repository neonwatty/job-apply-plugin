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
