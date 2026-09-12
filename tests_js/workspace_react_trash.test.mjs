import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
async function compile(file, replacements = {}) {
    const source = await readFile(new URL(`../apps/companion/components/${file}`, import.meta.url), 'utf8');
    let output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    for (const [from, to] of Object.entries(replacements)) output = output.replaceAll(from, to);
    return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}
const modelUrl = await compile('trash-model.ts', {
    '../../../src/contracts/workspace/values': new URL('../runtime/contracts/workspace/values.js', import.meta.url).href
});
const model = await import(modelUrl);
const answerModelUrl = await compile('answer-model.ts', {
    '../../../src/contracts/workspace/values': new URL('../runtime/contracts/workspace/values.js', import.meta.url).href,
    '../../../src/contracts/python-object': new URL('../runtime/contracts/python-object.js', import.meta.url).href
});
const { createTrashClient } = await import(await compile('trash-client.ts', { './trash-model': modelUrl, './answer-model': answerModelUrl }));
const item = { type: 'job', id: 'synthetic/job #1', label: 'Synthetic job', revision: 1, deletedAt: '2026-09-11', blockerCounts: { claims: 0 } };
const listing = (items = [item]) => JSON.stringify({ items, total: items.length,
    counts: Object.fromEntries(['job', 'resume', 'answer'].map(type => [type, items.filter(item => item.type === type).length])) });

test('Trash projection preserves exact integer revisions and omits incidental private fields', () => {
    const [projected] = model.trashSnapshot(listing([{ ...item, value: 'PRIVATE', path: '/private/file', url: 'https://private.invalid' }])
        .replace('"revision":1', '"revision":9007199254740993')).items;
    assert.equal(projected.revision, 9007199254740993n);
    assert.equal('value' in projected, false);
    assert.equal('path' in projected, false);
    assert.equal('url' in projected, false);
    for (const revision of ['0', '-1', 'true', '1.0', 'null'])
        assert.throws(() => model.trashSnapshot(listing().replace('"revision":1', `"revision":${revision}`)));
    assert.throws(() => model.trashSnapshot(listing([item, item])));
    assert.throws(() => model.trashSnapshot(listing().replace('"total":1', '"total":0')));
    assert.throws(() => model.trashSnapshot(listing([{ ...item, type: 'secret' }])));
    assert.throws(() => model.trashSnapshot(listing([{ ...item, blockerCounts: { claims: -1 } }])));
    assert.equal(model.trashSnapshot(listing([])).total, 0);
});

test('adapter uses fixed encoded routes, exact revision only, and accepts recordless deletion', async () => {
    const requests = [];
    const client = createTrashClient('synthetic-token', model.compatibilityTrashCapabilities, async (path, options) => {
        requests.push({ path, options });
        return new Response(options.method === 'GET' ? listing() : '{"deleted":true}', { status: 200 });
    });
    const signal = new AbortController().signal;
    assert.equal((await client.list(signal)).total, 1);
    for (const type of ['job', 'resume', 'answer']) {
        await client.mutate({ ...item, type, revision: 9007199254740993n }, 'delete', signal);
        const call = requests.at(-1);
        assert.equal(call.path, type === 'answer' ? `/api/answers/by-key/${Buffer.from(item.id).toString('base64url')}/delete` : `/api/${{ job: 'jobs', resume: 'resumes' }[type]}/synthetic%2Fjob%20%231/delete`);
        assert.equal(call.options.body, '{"expectedRevision":9007199254740993}');
        assert.equal(call.options.headers.Authorization, 'Bearer synthetic-token');
    }
});

test('answer dot-segment keys preserve identity through browser URL normalization', async () => {
    const seen = [];
    const client = createTrashClient('synthetic', model.nativeTrashCapabilities, async path => {
        seen.push(new Request(new URL(path, 'http://localhost:1234')).url);
        return new Response('{}');
    });
    for (const id of ['.', '..']) for (const action of ['restore', 'delete']) {
        await client.mutate({ ...item, type:'answer', id, revision:1n }, action, new AbortController().signal);
        assert.equal(new URL(seen.at(-1)).pathname, `/api/answers/by-key/${Buffer.from(id).toString('base64url')}/${action}`);
    }
});

test('adapter refuses capability-disabled actions before transport', async () => {
    let calls = 0;
    const limited = {...model.nativeTrashCapabilities, resume:{restore:false,delete:false}};
    const client = createTrashClient('synthetic', limited, async () => { ++calls; return new Response('{}'); });
    const signal = new AbortController().signal;
    for (const type of ['job', 'resume', 'answer']) for (const action of ['restore', 'delete']) {
        if (type !== 'resume') continue;
        await assert.rejects(client.mutate({ ...item, type, revision: 1n }, action, signal), { code: 'unsupported_operation' });
    }
    assert.equal(calls, 0);
    await client.mutate({ ...item, revision: 1n }, 'restore', signal);
    assert.equal(calls, 1);
    const native = createTrashClient('synthetic', model.nativeTrashCapabilities, async () => { ++calls; return new Response('{}'); });
    await native.mutate({ ...item, type:'resume', revision:1n }, 'restore', signal);
    assert.equal(calls, 2);
});

test('errors preserve count guidance while suppressing private server messages and never retry', async () => {
    for (const [code, counts, expected] of [
        ['revision_conflict', {}, /changed elsewhere/], ['record_referenced', { history: 2 }, /2 protected references/],
        ['recovery_required', {}, /recovery is required/], ['request_error', {}, /could not be confirmed/]
    ]) {
        let calls = 0;
        const client = createTrashClient('synthetic', model.compatibilityTrashCapabilities, async () => {
            ++calls;
            return new Response(JSON.stringify({ error: { code, counts, message: '/private/value secret-token' } }), { status: 409 });
        });
        await assert.rejects(client.mutate({ ...item, revision: 1n }, 'delete', new AbortController().signal), error => {
            assert.match(model.trashErrorText(error), expected);
            assert.doesNotMatch(model.trashErrorText(error), /private|secret-token/);
            return true;
        });
        assert.equal(calls, 1);
    }
    assert.equal(model.deletePhrase('answer'), 'DELETE ANSWER');
    assert.doesNotMatch(model.trashErrorText({code:'session_reference_blocked',counts:{sessions:1}}), /Complete or abandon/);
});
