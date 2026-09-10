import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const execute = promisify(execFile);

export async function resumeDraftBrowser(page, root, fixture, buildRoot, id) {
    const stored = async () => JSON.parse(await readFile(join(root, 'resumes.json'), 'utf8')).resumes[id];
    async function externalPatch(patch) {
        const current = await stored();
        const input = join(fixture.root, 'resume-concurrent-patch.json');
        await writeFile(input, JSON.stringify(patch));
        await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'), '--root', root,
            '--native-lock', fixture.receipt.artifact, 'resume-update', '--id', id,
            '--expected-revision', String(current.revision), '--input', input], { env: { PATH: '' } });
    }

    // A clean refresh adopts canonical values; it must not turn stale fields into an editable draft.
    await externalPatch({ label: 'Concurrent label' });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'Concurrent label', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Label', { exact: true }).inputValue(), 'Concurrent label');
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);

    // A dirty refresh keeps the original revision until the owner explicitly reapplies changed fields.
    await page.getByLabel('Label', { exact: true }).fill('My resume draft');
    await externalPatch({ tags: ['concurrent-tag'] });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('This resume changed elsewhere. Your draft is preserved.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Label', { exact: true }).inputValue(), 'My resume draft');
    await page.getByRole('button', { name: 'Reapply my draft', exact: true }).click();
    assert.equal(await page.getByLabel('Tags, separated by commas').inputValue(), 'concurrent-tag');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Resume details saved', { exact: true }).waitFor();
    assert.equal((await stored()).label, 'My resume draft');
    assert.deepEqual((await stored()).tags, ['concurrent-tag']);

    // Metadata entered before choosing a file is a real import draft.
    await page.getByRole('button', { name: 'Import resume', exact: true }).click();
    await page.getByLabel('Label', { exact: true }).fill('Unsaved import');
    let prompts = 0;
    const dismiss = async dialog => { prompts++; await dialog.dismiss(); };
    page.on('dialog', dismiss);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(prompts, 1);
    assert.equal(await page.getByLabel('Label', { exact: true }).inputValue(), 'Unsaved import');
    await page.getByRole('button', { name: 'Jobs', exact: true }).click();
    assert.equal(prompts, 2);
    assert.equal(await page.getByLabel('Label', { exact: true }).inputValue(), 'Unsaved import');
    page.off('dialog', dismiss);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
}
