import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const root = new URL('../apps/companion/components/', import.meta.url);
async function modules(run) {
    const temp = await mkdtemp(join(tmpdir(), 'react-editor-'));
    try {
        for (const name of ['contracts', 'job-editor-state', 'client', 'facts-model']) {
            const text = await readFile(new URL(name + '.ts', root), 'utf8');
            const js = ts.transpileModule(text, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022
                }
            }).outputText.replaceAll("'./contracts'", "'./contracts.mjs'")
                .replaceAll("'./facts-model'", "'./facts-model.mjs'")
                .replace(/'\.\.\/\.\.\/\.\.\/src\/([^']+)'/g, (_match, path) =>
                    JSON.stringify(new URL('../runtime/' + path + '.js', import.meta.url).href));
            await writeFile(join(temp, name + '.mjs'), js);
        }
        await run(await import(pathToFileURL(join(temp, 'job-editor-state.mjs'))), await import(pathToFileURL(join(temp, 'contracts.mjs'))), await import(pathToFileURL(join(temp, 'client.mjs'))), await import(pathToFileURL(join(temp, 'facts-model.mjs'))));
    }
    finally {
        await rm(temp, {
            recursive: true, force: true
        });
    }
}
async function editorDraftAssertions() {
    return modules((m) => {
        const first = {
            id: 'one', url: 'https://example.invalid', revision: 1, status: 'saved', company: 'Old', notes: ''
        };
        const draft = m.edit(m.openEditor(first), {
            notes: 'Mine'
        });
        const latest = {
            ...first, revision: 2, company: 'Other'
        };
        const observed = m.observe(draft, [latest]);
        assert.equal(observed.fields.notes, 'Mine');
        assert.equal(observed.selected.revision, 1);
        assert.equal(m.observe({
            ...observed, latest: {
                ...latest, revision: 3
            }
        }, [latest]).latest.revision, 3);
        const rebased = m.reapply(observed);
        assert.equal(rebased.selected.revision, 2);
        assert.equal(rebased.fields.company, 'Other');
        assert.equal(rebased.fields.notes, 'Mine');
        assert.deepEqual([...rebased.dirty], ['notes']);
        assert.equal(m.openEditor(latest).dirty.size, 0);
        const missing = m.observe(draft, []);
        assert.equal(missing.missing, true);
        assert.equal(missing.fields.notes, 'Mine');
        assert.equal(m.observe(missing, [first]).missing, false);
        assert.equal(m.edit(draft, { notes: '' }).dirty.size, 0);
    });
}
async function editorDtoAssertions() {
    return modules((m, c) => {
        const legacyResume = {
            id: 'legacy', label: 'Legacy', default: true, revision: 1,
            createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z'
        };
        assert.deepEqual(c.resumeList({ resumes: [legacyResume] })[0].tags, []);
        assert.throws(() => c.resume({ ...legacyResume, tags: null }));
        assert.throws(() => c.resume({ ...legacyResume, tags: [1] }));
        assert.throws(() => c.job({
            id: 'x', revision: 0, status: 'saved', url: 'x'
        }));
        assert.throws(() => c.workspaceState({
            jobs: [], resumes: [null]
        }));
        const value = {
            id: 'x', revision: 1, status: 'saved', url: 'https://example.invalid', provenance: {
                source: 'human'
            }
        };
        assert.deepEqual(c.job(value), value);
        assert.deepEqual(c.boot({
            status: 'ready'
        }), {
            status: 'ready'
        });
        assert.throws(() => c.overview({
            setup: {}, counts: {}, nextAction: 'x', targetWorkspace: 'jobs'
        }));
    });
}
async function cancellationAssertions() {
    await modules(async (_m, _c, clientModule) => {
        const original = globalThis.fetch;
        try {
            const controller = new AbortController();
            let observed;
            globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
                observed = options.signal;
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
            const pending = clientModule.createClient('fixture').state(controller.signal);
            assert.ok(observed instanceof AbortSignal);
            assert.notEqual(observed, controller.signal, 'Caller cancellation is combined with a deadline');
            controller.abort();
            await assert.rejects(pending, { name: 'AbortError' });
            assert.equal(observed.aborted, true);
        } finally { globalThis.fetch = original; }
    });
}
async function factsDraftAssertions() {
    return modules((_m, _c, _client, facts) => {
        const base = facts.snapshot('{"profile":{"name":"Old","extra":{"huge":9007199254740993,"float":1.0,"note":"Old"}},"revision":1,"factProvenance":{}}');
        const draft = facts.snapshot('{"profile":{"name":"Mine","extra":{"huge":9007199254740993,"float":1.0,"note":"Changed"}},"revision":1,"factProvenance":{}}');
        const latest = facts.snapshot('{"profile":{"name":"Old","phone":"Other","extra":{"huge":9007199254740993,"float":1.0,"note":"Old"}},"revision":2,"factProvenance":{}}');
        const rebased = facts.reapplyDraft(base.profile, draft.profile, latest.profile);
        const payload = facts.patchBody(latest, rebased);
        assert.match(payload, /9007199254740993/);
        assert.match(payload, /1\.0/);
        const parsed = JSON.parse(payload);
        assert.equal(parsed.expectedRevision, 2);
        assert.equal(parsed.patch.name, 'Mine');
        assert.equal(Object.hasOwn(parsed.patch, 'phone'), false);
        assert.deepEqual(parsed.atomicPaths, ['/name', '/extra']);
    });
}
export async function nextEditor() {
    await factsDraftAssertions();
    await editorDraftAssertions();
    await editorDtoAssertions();
    await cancellationAssertions();
}
