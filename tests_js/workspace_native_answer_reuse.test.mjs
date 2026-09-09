import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { initializeJobsFixture, NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const packet = (changes = {}) => ({ question: 'Is employment authorization available in the country?',
  scope: { ats: 'greenhouse' }, fieldClass: 'authorization', sensitivity: 'none', mode: 'strict', useAuthority: 'accepted_record', ...changes });
const records = [
  { key: 'work', question: 'Does the applicant have permission to work in this jurisdiction?', state: 'confirmed', value: 'PRIVATE-WORK-VALUE', scope: { ats: 'greenhouse' }, fieldClass: 'authorization' },
  { key: 'private', question: 'Preferred name?', state: 'confirmed', value: 'PRIVATE-NAME-VALUE', scope: {}, fieldClass: 'identity', sensitivity: 'personal' },
  { key: 'integer', question: 'Exact numeric scope?', state: 'confirmed', value: 'PRIVATE-INTEGER-VALUE', scope: { number: 1 } },
];

test('semantic HTTP and Python-free CLI agree with Python Store and do not persist or expose values', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const root = join(await realpath(fixture.root), 'native-reuse');
    await initializeJobsFixture(root);
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const writer = new AnswersService(new NativeJobsRepository(root, provider));
    for (const record of records) await writer.put(fromJSON(record), true);
    const queries = [packet(), packet({ question: 'No permission to work in this jurisdiction' }),
      packet({ fieldClass: 'relocation' }), packet({ scope: { ats: 'other' } }),
      packet({ question: 'Preferred name?', scope: {}, fieldClass: 'identity', sensitivity: 'personal', useAuthority: 'accepted_record' }),
      packet({ question: 'Preferred name?', scope: {}, fieldClass: 'identity', sensitivity: 'personal', useAuthority: 'per_use' }),
      packet({ question: 'Preferred name?', scope: {}, fieldClass: 'identity', sensitivity: 'personal', mode: 'bounded_loose', useAuthority: 'bounded_policy', allowedSensitiveFieldClasses: ['identity'] }),
      packet({ question: 'Exact numeric scope?', scope: { number: true }, fieldClass: 'general' }),
      packet({ question: 'Exact numeric scope?', scope: { number: 1 }, fieldClass: 'general' }),
    ];
    const script = `import sys,json,importlib.util\nfrom pathlib import Path\nsys.path.insert(0,'scripts')\nspec=importlib.util.spec_from_file_location('reuse_reference','scripts/job-apply-store.py')\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ns=m.Store(Path(sys.argv[1]));s.initialize()\nfor record in json.loads(sys.argv[2]):s.put_answer(record,remember_sensitive=True)\nprint(json.dumps([s.semantic_answer_lookup(q) for q in json.loads(sys.argv[3])]))`;
    const expected = JSON.parse(execFileSync('python3', ['-c', script, join(fixture.root, 'python'), JSON.stringify(records), JSON.stringify(queries)], { encoding: 'utf8' }));
    const files = (await readdir(root)).filter(name => name.endsWith('.json'));
    const before = await Promise.all(files.map(name => readFile(join(root, name), 'utf8')));
    const readonly = new NativeJobsRepository(root, provider, async () => { throw Error('semantic lookup attempted persistence'); });
    const service = new AnswersService(readonly), jobs = new JobsService(readonly);
    for (let index = 0; index < queries.length; index++) {
      const value = JSON.parse(serialize(await service.semanticLookup(fromJSON(queries[index]))));
      assert.deepEqual(value, expected[index]);
      const http = await jobsHttp(jobs, readonly, 'POST', '/api/answers/semantic', JSON.stringify(queries[index]));
      assert.equal(http.status, 200);
      assert.deepEqual(JSON.parse(http.body), expected[index]);
      const result = spawnSync(process.execPath, ['runtime/cli/native-jobs.js', '--root', root, '--native-lock', fixture.receipt.artifact,
        'answer-semantic-lookup', '--input', '-'], { input: JSON.stringify(queries[index]), encoding: 'utf8', env: { PATH: '' } });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected[index]);
      assert.doesNotMatch(result.stdout, /PRIVATE-|Does the applicant|Preferred name/);
      for (const candidate of value.candidates) assert.deepEqual(Object.keys(candidate).sort(), ['answerKey', 'confidenceBand', 'reasonCodes']);
      assert.equal(value.mutated, false);
    }
    assert.deepEqual(await Promise.all(files.map(name => readFile(join(root, name), 'utf8'))), before);
    await writer.update('work', fromJSON({ state: 'inferred' }), 1n);
    const current = JSON.parse(serialize(await service.semanticLookup(fromJSON(packet()))));
    assert.ok(!current.candidates.find(item => item.answerKey === 'work').reasonCodes.includes('reuse_eligible'));
    for (const invalid of [{}, packet({ limit: true }), packet({ scope: null }), packet({ question: '' }), packet({ extra: 'PRIVATE-BAD-VALUE' })]) {
      const result = await jobsHttp(jobs, readonly, 'POST', '/api/answers/semantic', JSON.stringify(invalid));
      assert.equal(result.status, 400);
      assert.doesNotMatch(result.body, /PRIVATE-/);
    }
  } finally { await fixture.cleanup(); }
});
