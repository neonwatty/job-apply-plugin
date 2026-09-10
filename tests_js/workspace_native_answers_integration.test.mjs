import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, writeFile, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const execute = promisify(execFile);

test('native answers share locked durable state across HTTP and Python-free CLI', { timeout: 60000 }, async t => {
    const fixture = await nativeFixture();
    try {
        const root = join(await realpath(fixture.root), 'answers');
        await initializeJobsFixture(root);
        const provider = loadPosixFlockProvider(fixture.receipt.artifact);
        const repository = new NativeJobsRepository(root, provider);
        const service = new AnswersService(repository);
        const jobs = new JobsService(repository);
        const path = join(root, 'answers.json');
        const cli = async args => execute(process.execPath, [join(process.cwd(), 'runtime/cli/native-jobs.js'),
            '--root', root, '--native-lock', fixture.receipt.artifact, ...args], { env: { PATH: '' } });
        await t.test('HTTP creation and CLI editing persist and missing details return 404', async () => {
            const result = await jobsHttp(jobs, repository, 'POST', '/api/answers', JSON.stringify({ answer: {
                key: 'shared', question: 'Preferred location?', state: 'confirmed', value: 'Remote'
            } }));
            assert.equal(result.status, 200);
            const patch = join(fixture.root, 'answer-patch.json');
            await writeFile(patch, '{"value":"Hybrid"}');
            const updated = JSON.parse((await cli(['answer-update', '--key', 'shared', '--expected-revision', '1', '--input', patch])).stdout);
            assert.equal(updated.revision, 2);
            assert.equal(JSON.parse(serialize(await new AnswersService(new NativeJobsRepository(root, provider)).get('shared'))).value, 'Hybrid');
            assert.equal(JSON.parse(await readFile(path, 'utf8')).answers.shared.value, 'Hybrid');
            assert.equal((await jobsHttp(jobs, repository, 'GET', '/api/answers/by-key/bWlzc2luZw')).status, 404);
        });
        await t.test('concurrent CLI writers admit one expected revision', async () => {
            const patch = join(fixture.root, 'answer-concurrent.json');
            await writeFile(patch, '{"value":"Concurrent"}');
            const results = await Promise.allSettled(Array.from({ length: 4 }, () => cli([
                'answer-update', '--key', 'shared', '--expected-revision', '2', '--input', patch
            ])));
            assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
            for (const result of results.filter(result => result.status === 'rejected')) assert.match(result.reason.stderr, /revision conflict/);
            assert.equal(JSON.parse(await readFile(path, 'utf8')).answers.shared.revision, 3);
        });
        await t.test('failed persistence and invalid documents leave canonical bytes unchanged', async () => {
            const before = await readFile(path);
            const failing = new NativeJobsRepository(root, provider, async (file, ...args) => {
                if (basename(file) === 'answers.json') throw Error('injected answer write failure');
                return atomicWritePointJson(file, ...args);
            });
            await assert.rejects(new AnswersService(failing).update('shared', fromJSON({ value: 'Not saved' }), 3n), /injected answer write failure/);
            assert.deepEqual(await readFile(path), before);
            const corrupted = Buffer.from('{"schemaVersion":1,"answers":[],"metadata":{}}');
            await writeFile(path, corrupted);
            await assert.rejects(service.query(), /object/);
            assert.deepEqual(await readFile(path), corrupted);
            await writeFile(path, before);
        });
        await t.test('unsupported reference state is rejected before assuming empty counts', async () => {
            const before = await readFile(path);
            await writeFile(join(root, 'history.jsonl'), '', { mode: 0o600 });
            await assert.rejects(service.query(), /unsupported state/);
            assert.deepEqual(await readFile(path), before);
            await unlink(join(root, 'history.jsonl'));
        });
        await t.test('sensitive HTTP and CLI output is redacted until explicit reveal', async () => {
            await service.put(fromJSON({ key: 'private', question: 'Private fixture?', state: 'sensitive', value: 'synthetic-sensitive' }), true);
            const response = await jobsHttp(jobs, repository, 'GET', '/api/answers/private');
            assert.equal(response.status, 200);
            assert.equal(response.body.includes('synthetic-sensitive'), false);
            assert.equal((await cli(['answer-list'])).stdout.includes('synthetic-sensitive'), false);
            const reveal = await jobsHttp(jobs, repository, 'POST', '/api/answers/private/reveal', '{}');
            assert.equal(JSON.parse(reveal.body).value, 'synthetic-sensitive');
        });
    } finally { await fixture.cleanup(); }
});
