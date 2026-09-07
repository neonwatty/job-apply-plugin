import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureCorpus, compareReference, validateCorpus }
  from '../tools/contracts/answer-matching-raw/capture.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HERE = join(ROOT, 'tools/contracts/answer-matching-raw');
const GOLDEN = join(ROOT, 'test/contract/vectors/python-answer-matching-raw-v1.json');
const golden = JSON.parse(await readFile(GOLDEN, 'utf8'));
const clone = () => structuredClone(golden);
const available = (python) => spawnSync(python, ['--version'], { timeout: 3000 }).status === 0;
const cli = (args) => spawnSync(process.execPath, [join(HERE, 'capture.mjs'), ...args], {
  encoding: 'utf8', timeout: 15_000,
});

test('raw application and harness contracts are deterministic on the current interpreter', () => {
  const first = captureCorpus();
  assert.deepEqual(captureCorpus(), first);
  assert.equal(first.cases.length, 42);
  assert.deepEqual(compareReference(first, golden).applicationMismatches, []);
});

for (const python of ['python3.12', 'python3.13', 'python3.14']) {
  test(`exact reference provenance and error text: ${python}`, (t) => {
    if (!available(python)) return t.skip(`${python} unavailable; no parity claimed`);
    const actual = captureCorpus({ python });
    const compared = compareReference(actual, golden);
    t.diagnostic(JSON.stringify({ provenance: actual.provenance, ...compared }));
    assert.deepEqual(compared.applicationMismatches, []);
    if (!compared.profileKnown) return t.skip('interpreter profile not frozen; differences reported above');
    assert.deepEqual(compared.expectedProfileMismatches, []);
  });
}

test('the original 18 diagnostic request strings survive byte for byte', async () => {
  const previous = [];
  for (const file of ['matching-numeric-provenance.json', 'matching-controls-provenance.json']) {
    previous.push(...JSON.parse(await readFile(join(ROOT, 'docs/integration-evidence', file))).cases);
  }
  assert.deepEqual(golden.cases.slice(0, 18).map((c) => c.rawRequest), previous.map((c) => c.rawRequest));
});

test('numeric spelling, duplicate keys, malformed JSON and non-finite behavior are frozen', () => {
  const cases = new Map(golden.cases.map((c) => [c.id, JSON.parse(c.stdout)]));
  for (const id of ['integral-float', 'exponent', 'negative-zero', 'nested', 'nested-object-float']) {
    assert.equal(cases.get(id).result[0].confidenceBand, 'none');
  }
  for (const id of ['equal-exponent-floats', 'large-equal-integers', 'nan-scope',
    'infinity-scope', 'escaped-key', 'duplicate-scope-key', 'float-underflow']) {
    assert.equal(cases.get(id).result[0].confidenceBand, 'exact');
  }
  assert.equal(cases.get('duplicate-limit-last-float').error.name, 'AnswerMatchError');
  assert.equal(cases.get('invalid-number').error.name, 'JSONDecodeError');
  assert.equal(cases.get('integer-digit-limit').error.name, 'ValueError');
});

test('harness input, depth and output limits remain distinct from application contracts', () => {
  for (const kind of ['input', 'depth', 'output']) {
    const item = golden.cases.find((c) => c.id === `${kind}-limit`);
    assert.equal(item.layer, 'harness');
    assert.deepEqual(JSON.parse(item.stdout), {
      error: { name: 'HarnessLimitError', message: `${kind} limit exceeded` },
    });
  }
  const within = golden.cases.find((c) => c.id === 'depth-within-harness');
  assert.equal(within.layer, 'application');
  assert.ok(JSON.parse(within.stdout).result);
});

test('closed envelopes, fixed synthetic inputs and privacy-safe outputs are enforced', () => {
  for (const mutate of [
    (v) => { v.extra = true; },
    (v) => { v.provenance.extra = true; },
    (v) => { v.cases[0].extra = true; },
    (v) => { v.cases[0].rawRequest = '{"private":"uncontrolled"}'; },
    (v) => { v.cases[1].id = v.cases[0].id; },
    (v) => { v.cases.pop(); },
    (v) => { v.cases[0].stdout = '{"result":[],"extra":true}\n'; },
    (v) => { v.cases[0].stdout = '{"result":[{"private":true}]}\n'; },
    (v) => { v.cases[0].stdout = 'RAW_REFERENCE_SECRET_CANARY\n'; },
    (v) => { v.cases[0].stdout = '/Users/synthetic/private\n'; },
    (v) => { v.alternateReferences[0].overrides[0].id = 'integer-control'; },
  ]) {
    const value = clone();
    mutate(value);
    assert.throws(() => validateCorpus(value), { message: 'raw_reference_invalid' });
  }
  assert.equal(golden.cases.some((c) => c.stdout.includes('RAW_REFERENCE_SECRET_CANARY')), false);
});

test('comparisons report exact interpreter differences and never hide application changes', () => {
  const value = clone();
  value.cases[0].stdout = '{"result":[]}\n';
  const compared = compareReference(value, golden);
  assert.deepEqual(compared.applicationMismatches, ['integer-control']);
  assert.deepEqual(compared.expectedProfileMismatches, ['integer-control']);
  const unknown = clone();
  unknown.provenance.python = '3.99.0';
  assert.equal(compareReference(unknown, golden).profileKnown, false);
});

test('capture rejects uncontrolled options and Python driver rejects arguments and stdin', () => {
  for (const options of [{ input: '{}' }, { root: '/private' }, { python: '/arbitrary' }, null]) {
    assert.throws(() => captureCorpus(options), { message: 'raw_reference_invalid' });
  }
  for (const [args, input] of [[['--root', 'PRIVATE_CANARY'], ''], [[], 'PRIVATE_CANARY']]) {
    const result = spawnSync('python3', ['-I', join(HERE, 'reference.py'), ...args], {
      input, encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'raw_reference_failed\n');
  }
});

test('candidate capture refuses overwrite, repository aliases and caller Store roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'raw-reference-test-'));
  const before = await readFile(GOLDEN);
  try {
    const existing = join(directory, 'existing.json');
    await writeFile(existing, 'unchanged');
    const alias = join(directory, 'repo-alias');
    await symlink(ROOT, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const link = join(directory, 'file-link.json');
    await symlink(existing, link);
    const otherRepo = join(directory, 'other-repository');
    assert.equal(spawnSync('git', ['init', '--quiet', otherRepo]).status, 0);
    for (const args of [
      ['--output', GOLDEN], ['--output', existing], ['--output', link],
      ['--output', join(alias, 'forbidden.json')], ['--output', 'relative.json'],
      ['--output', join(otherRepo, 'forbidden.json')],
      ['--output', join(otherRepo, '.git', 'forbidden.json')],
      ['--root', directory, '--output', join(directory, 'bad.json')],
      ['--output', join(directory, 'bad.json'), '--python', '/arbitrary'],
    ]) {
      const result = cli(args);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'raw_reference_capture_failed\n');
    }
    assert.equal(await readFile(existing, 'utf8'), 'unchanged');
    assert.deepEqual(await readFile(GOLDEN), before);
    const candidate = join(directory, 'candidate.json');
    assert.equal(cli(['--output', candidate]).status, 0);
    validateCorpus(JSON.parse(await readFile(candidate, 'utf8')));
    if (process.platform !== 'win32') assert.equal((await stat(candidate)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
