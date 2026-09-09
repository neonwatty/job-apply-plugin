import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeAnswerCreationBrowser } from './workspace_native_answer_creation_browser_support.mjs';

const execute = promisify(execFile);

export async function nativeAnswersBrowser(page, root, fixture, buildRoot) {
    const input = join(fixture.root, 'answer-browser-input.json');
    async function cli(command, body, args = []) {
        await writeFile(input, body);
        return JSON.parse((await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'),
            '--root', root, '--native-lock', fixture.receipt.artifact, command, '--input', input, ...args],
        { env: { PATH: '' } })).stdout);
    }
    const stored = async key => JSON.parse(await readFile(join(root, 'answers.json'), 'utf8')).answers[key];
    await cli('answer-put', '{"key":"browser-answer","question":"Preferred work location?","state":"confirmed","value":"Remote","scope":{"exact":9007199254740993,"decimal":1.0}}');
    await cli('answer-put', '{"key":"private-answer","question":"Private remembered answer?","state":"sensitive","value":"synthetic-private-value"}', ['--remember-sensitive']);
    const pending = await cli('answer-observe', '{"question":"Suggested answer?","value":"Suggested value"}');
    await page.getByRole('button', { name: 'Answers', exact: true }).click();
    await page.getByRole('button', { name: 'Preferred work location?', exact: true }).click();
    await page.getByLabel('Answer value', { exact: true }).fill('My answer draft');
    await cli('answer-update', '{"source":"concurrent-client"}', ['--key', 'browser-answer', '--expected-revision', '1']);
    await page.getByRole('button', { name: 'Save answer', exact: true }).click();
    await page.getByRole('button', { name: 'Reapply my changes', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Answer value', { exact: true }).inputValue(), 'My answer draft');
    await page.getByRole('button', { name: 'Reapply my changes', exact: true }).click();
    assert.equal(await page.getByLabel('Source', { exact: true }).inputValue(), 'concurrent-client');
    await page.getByRole('button', { name: 'Save answer', exact: true }).click();
    await page.getByText('Answer saved.', { exact: true }).waitFor();
    assert.equal((await stored('browser-answer')).value, 'My answer draft');
    assert.equal((await stored('browser-answer')).source, 'concurrent-client');
    const bytes = await readFile(join(root, 'answers.json'), 'utf8');
    assert.match(bytes, /9007199254740993/);
    assert.match(bytes, /"decimal":\s*1\.0/);

    await page.getByRole('button', { name: 'Private remembered answer?', exact: true }).click();
    await page.getByRole('button', { name: 'Replace hidden answer', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Answer value', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Replace hidden answer', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Reveal sensitive value', exact: true }).click();
    await page.getByLabel('Answer value', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Answer value', { exact: true }).inputValue(), 'synthetic-private-value');
    await page.getByLabel('Answer value', { exact: true }).fill('changed-private-value');
    await page.getByRole('button', { name: 'Save answer', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /remember consent/ }).waitFor();
    assert.equal((await stored('private-answer')).value, 'synthetic-private-value');
    await page.getByRole('button', { name: 'Reapply my changes', exact: true }).click();
    await page.getByLabel('I consent to remembering the sensitive value in this edit.').check();
    await page.getByRole('button', { name: 'Save answer', exact: true }).click();
    await page.getByText('Answer saved.', { exact: true }).waitFor();
    assert.equal((await stored('private-answer')).value, 'changed-private-value');
    assert.equal(await page.getByLabel('Answer value', { exact: true }).count(), 0);

    await page.getByLabel('Review status', { exact: true }).selectOption('pending');
    await page.getByRole('button', { name: 'Search answers', exact: true }).click();
    await page.getByRole('button', { name: 'Suggested answer?', exact: true }).click();
    await page.getByRole('button', { name: 'Accept answer', exact: true }).click();
    await page.getByText('Answer saved.', { exact: true }).waitFor();
    assert.equal((await stored(pending.key)).reviewStatus, 'accepted');

    await page.reload();
    await page.getByRole('button', { name: 'Answers', exact: true }).click();
    await page.getByRole('button', { name: 'Preferred work location?', exact: true }).click();
    assert.equal(await page.getByLabel('Answer value', { exact: true }).inputValue(), 'My answer draft');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    const creation = await nativeAnswerCreationBrowser(page, root);
    return { creation, persistedEdits: true, cliConflictReapply: true, losslessScope: true, explicitSensitiveConsent: true, review: true, reload: true, narrow: true };
}
