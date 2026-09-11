import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Requires the integrated native job/answer lifecycle backend and React Trash wiring.
// The caller owns the disposable fixture, production browser and service cleanup.
export async function nativeReactTrashBrowser(page, root, fixture, buildRoot) {
    const execute = promisify(execFile);
    const suffix = randomUUID();
    const input = join(fixture.root, `react-trash-native-${suffix}.json`);
    async function cli(command, args = [], payload) {
        if (payload !== undefined) {
            await writeFile(input, JSON.stringify(payload), { mode: 0o600 });
            args = [...args, '--input', input];
        }
        const result = await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'),
            '--root', root, '--native-lock', fixture.receipt.artifact, command, ...args], { env: { PATH: '' } });
        assert.equal(result.stderr, '');
        return JSON.parse(result.stdout);
    }
    const workspace = page.locator('.trash-workspace');
    const navigation = page.getByRole('navigation', { name: 'Workspace sections' });
    const refresh = page.getByRole('button', { name: 'Refresh Trash', exact: true });
    const filter = workspace.getByLabel('Record type');
    const modal = page.getByRole('dialog');
    const card = record => workspace.locator('.trash-card').filter({
        has: page.getByRole('heading', { name: record.label, exact: true })
    });
    const idle = () => page.waitForFunction(() => {
        const refresh = document.getElementById('trash-refresh');
        return refresh && !refresh.disabled;
    });
    async function reload() {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/trash' && response.ok());
        await refresh.click();
        await response;
        await idle();
    }
    const revisions = record => ['--' + (record.type === 'answer' ? 'key' : 'id'), record.id,
        '--expected-revision', String(record.revision)];
    async function get(record) {
        return cli(`${record.type}-get`, ['--' + (record.type === 'answer' ? 'key' : 'id'), record.id, '--include-trashed']);
    }
    const observedWrites = [];
    const observe = request => {
        if (request.method() === 'POST' && /\/(restore|delete)$/.test(new URL(request.url()).pathname)) {
            observedWrites.push({ pathname: new URL(request.url()).pathname, body: request.postData() });
        }
    };
    page.on('request', observe);
    try {
        const before = await cli('trash-list');
        const job = await cli('job-create', [], {
            role: `Native React Trash job ${suffix}`, company: 'Synthetic Trash company',
            url: `https://example.invalid/react-trash-${suffix}?private=PRIVATE-NATIVE-TRASH-URL`,
            notes: 'PRIVATE-NATIVE-TRASH-NOTES'
        });
        const key = `react-trash-回答-🧭-${suffix}`;
        const answer = await cli('answer-put', [], {
            key, question: `Native React Trash answer ${suffix}?`, state: 'confirmed',
            value: 'PRIVATE-NATIVE-TRASH-ANSWER'
        });
        assert.equal(answer.key, key);
        const records = [
            { type: 'job', id: job.id, label: job.role, revision: job.revision },
            { type: 'answer', id: key, label: answer.question, revision: answer.revision }
        ];
        for (const dotKey of ['.', '..']) {
            const dot = await cli('answer-put', [], { key: dotKey,
                question: `Native ${dotKey === '.' ? 'single' : 'double'} dot key ${suffix}?`, state: 'confirmed', value: 'PRIVATE-NATIVE-TRASH-ANSWER' });
            records.push({ type:'answer', id:dot.key, label:dot.question, revision:dot.revision });
        }
        for (const record of records) {
            const trashed = await cli(`${record.type}-trash`, revisions(record));
            assert.equal(trashed.revision, record.revision + 1);
            record.revision = trashed.revision;
        }
        await navigation.getByRole('button', { name: 'Trash', exact: true }).click();
        await idle();
        await reload();
        await workspace.getByText('Some lifecycle actions are not available in this workspace. Only supported actions are enabled.', { exact: true }).waitFor();
        assert.doesNotMatch(await workspace.innerText(), /PRIVATE-NATIVE-TRASH/);
        const listing = await cli('trash-list');
        assert.equal(listing.items.find(item => item.type === 'answer' && item.id === key)?.label, answer.question);
        assert.doesNotMatch(JSON.stringify(listing), /PRIVATE-NATIVE-TRASH/);

        // No unsupported resume mutation or direct fixture file edits are needed.
        await filter.selectOption('resume');
        const resumeCards = workspace.locator('.trash-card');
        const existingResumeCount = await resumeCards.count();
        for (let index = 0; index < existingResumeCount; index += 1) {
            const buttons = resumeCards.nth(index).getByRole('button');
            assert.equal(await buttons.nth(0).isDisabled(), true);
            assert.equal(await buttons.nth(1).isDisabled(), true);
        }
        for (const record of records) {
            await filter.selectOption(record.type);
            await card(record).getByRole('button', { name: 'Restore', exact: true }).click();
            const writeCount = observedWrites.length;
            await modal.getByRole('button', { name: 'Restore', exact: true }).click();
            await card(record).waitFor({ state: 'hidden' });
            await idle();
            assert.equal(observedWrites.length, writeCount + 1);
            assert.equal(observedWrites.at(-1).body, `{"expectedRevision":${record.revision}}`);
            if (record.type === 'answer') {
                const rawPath = `/api/answers/${encodeURIComponent(record.id)}/restore`;
                const byKeyPath = `/api/answers/by-key/${Buffer.from(record.id, 'utf8').toString('base64url')}/restore`;
                assert.ok([rawPath, byKeyPath].includes(observedWrites.at(-1).pathname), 'restore must address the exact Unicode answer key');
                const canonical = JSON.parse(await readFile(join(root, 'answers.json'), 'utf8')).answers;
                assert.equal(canonical[record.id].value, 'PRIVATE-NATIVE-TRASH-ANSWER');
                assert.equal(canonical[record.id].deletedAt, null);
            }
            const restored = await get(record);
            assert.equal(restored.deletedAt, null);
            assert.equal(restored.revision, record.revision + 1);
            record.revision = restored.revision;
            const trashed = await cli(`${record.type}-trash`, revisions(record));
            record.revision = trashed.revision;
            await reload();

            // An external lifecycle change invalidates the displayed exact revision.
            const concurrentRestore = await cli(`${record.type}-restore`, revisions(record));
            const concurrentTrash = await cli(`${record.type}-trash`, revisions({ ...record, revision: concurrentRestore.revision }));
            await card(record).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
            const confirm = modal.getByRole('button', { name: 'Delete permanently', exact: true });
            assert.equal(await confirm.isDisabled(), true);
            const phrase = `DELETE ${record.type.toUpperCase()}`;
            await modal.getByLabel(new RegExp(`Type ${phrase}`)).fill(phrase.toLowerCase());
            assert.equal(await confirm.isDisabled(), true);
            await modal.getByLabel(new RegExp(`Type ${phrase}`)).fill(phrase);
            const failedCount = observedWrites.length;
            await confirm.click();
            await workspace.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor();
            await idle();
            assert.equal(observedWrites.length, failedCount + 1);
            assert.equal(observedWrites.at(-1).body, `{"expectedRevision":${record.revision}}`);
            assert.doesNotMatch(await workspace.innerText(), /PRIVATE-NATIVE-TRASH/);
            assert.equal(await card(record).getByRole('button', { name: 'Restore', exact: true }).isDisabled(), true);
            assert.equal((await get(record)).revision, concurrentTrash.revision);
            record.revision = concurrentTrash.revision;
            await reload();
            await card(record).getByRole('button', { name: 'Delete permanently…', exact: true }).click();
            await modal.getByLabel(new RegExp(`Type ${phrase}`)).fill(phrase);
            const deletedCount = observedWrites.length;
            await confirm.click();
            await card(record).waitFor({ state: 'hidden' });
            await idle();
            assert.equal(observedWrites.length, deletedCount + 1);
            assert.equal(observedWrites.at(-1).body, `{"expectedRevision":${record.revision}}`);
            assert.equal(await get(record), null);
        }
        assert.deepEqual(await cli('trash-list'), before);
        return { nativeJobRestoreDelete: true, nativeAnswerRestoreDelete: true,
            exactUnicodeAnswerIdentity: true, dotSegmentAnswerIdentity: true, typedDeletionBothTypes: true,
            staleRevisionRejectedWithoutRetry: true, canonicalRecordsDeleted: true,
            errorAndListPrivacy: true, unrelatedTrashPreserved: true,
            resumeLimitationCopy: true, existingResumeCardsChecked: existingResumeCount,
            pythonAbsentFromCliPath: true };
    } finally {
        page.off('request', observe);
        await rm(input, { force: true });
    }
}
