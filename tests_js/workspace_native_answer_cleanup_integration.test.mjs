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

const winner = { key: 'winner', question: 'Does the applicant have permission to work in this jurisdiction?', state: 'confirmed', value: 'PRIVATE-CLEANUP-VALUE', fieldClass: 'authorization', sensitivity: 'personal' };
const duplicate = { question: 'Is employment authorization available in the country?', state: 'missing', fieldClass: 'authorization', sensitivity: 'personal' };

test('cleanup HTTP and Python-free CLI preserve Python token and canonical bytes', { timeout: 60000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const root = join(await realpath(fixture.root), 'native-cleanup');
    await initializeJobsFixture(root);
    const provider = loadPosixFlockProvider(fixture.receipt.artifact);
    const writer = new AnswersService(new NativeJobsRepository(root, provider));
    await writer.put(fromJSON(winner), true);
    await writer.observe(fromJSON(duplicate));
    const script = `import sys,json,importlib.util\nfrom pathlib import Path\nsys.path.insert(0,'scripts')\nspec=importlib.util.spec_from_file_location('cleanup_reference','scripts/job-apply-store.py')\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ns=m.Store(Path(sys.argv[1]));s.initialize()\ns.put_answer(json.loads(sys.argv[2]),remember_sensitive=True)\ns.observe_answer(json.loads(sys.argv[3]))\nprint(json.dumps(s.preview_answer_cleanup()))`;
    const expected = JSON.parse(execFileSync('python3', ['-c', script, join(fixture.root, 'python'), JSON.stringify(winner), JSON.stringify(duplicate)], { encoding: 'utf8' }));
    assert.equal(expected.proposals.length, 1);
    const files = (await readdir(root)).filter(name => name.endsWith('.json'));
    const snapshot = () => Promise.all(files.map(name => readFile(join(root, name), 'utf8')));
    const before = await snapshot();
    const repository = new NativeJobsRepository(root, provider, async () => { throw Error('preview attempted persistence'); });
    const service = new AnswersService(repository), jobs = new JobsService(repository);
    assert.deepEqual(JSON.parse(serialize(await service.cleanupPreview())), expected);
    const response = await jobsHttp(jobs, repository, 'GET', '/api/answers/cleanup-preview', '');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), expected);
    const cli = spawnSync(process.execPath, ['runtime/cli/native-jobs.js', '--root', root, '--native-lock', fixture.receipt.artifact, 'answer-cleanup-preview'], { encoding: 'utf8', env: { PATH: '' } });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), expected);
    assert.doesNotMatch(cli.stdout, /PRIVATE-CLEANUP-VALUE/);
    assert.deepEqual(await snapshot(), before);
    const unsupported = await jobsHttp(jobs, repository, 'POST', '/api/answers/cleanup-approve', '{}');
    assert.equal(unsupported.status, 501);
    assert.deepEqual(await snapshot(), before);
    await writer.put(fromJSON({ question: 'Unrelated answer?', state: 'missing' }));
    const changed = JSON.parse(serialize(await service.cleanupPreview()));
    assert.deepEqual(changed.proposals, expected.proposals);
    assert.notEqual(changed.previewToken, expected.previewToken);
    await writer.update('winner', fromJSON({ state: 'inferred' }), 1n, true);
    assert.deepEqual(JSON.parse(serialize(await service.cleanupPreview())).proposals, []);
  } finally { await fixture.cleanup(); }
});
