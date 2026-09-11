import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Runs only in the caller's disposable native fixture; Python is absent from CLI PATH.
export async function nativeAnswerLifecycleBrowser(page, root, fixture, buildRoot) {
  const execute = promisify(execFile), suffix = randomUUID();
  const key = `browser-lifecycle/é😀-${suffix}`, question = `Lifecycle browser answer ${suffix}?`;
  const sensitiveKey = `browser-lifecycle-sensitive-${suffix}`;
  const privateValue = `PRIVATE-LIFECYCLE-${suffix}`, savedValue = `SAVED-LIFECYCLE-${suffix}`;
  async function cli(command, args = [], payload) {
    if (payload !== undefined) {
      const input = join(fixture.root, `answer-lifecycle-${suffix}.json`);
      await writeFile(input, JSON.stringify(payload), {mode:0o600});
      args = [...args, '--input', input];
    }
    const result = await execute(process.execPath, [join(buildRoot, 'runtime/cli/native-jobs.js'),
      '--root', root, '--native-lock', fixture.receipt.artifact, command, ...args],
    {env:{PATH:''}, timeout:15000});
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }
  const args = (id, revision) => ['--key', id, '--expected-revision', String(revision)];
  const route = (id, operation) => `/api/answers/${encodeURIComponent(id)}/${operation}`;
  async function api(path, body) {
    const authorization = await page.evaluate(() => `Bearer ${sessionStorage.getItem('jobApplyWorkspaceToken')}`);
    const response = await page.request.fetch(new URL(path, page.url()).href, {
      method:body === undefined ? 'GET' : 'POST',
      headers:{Authorization:authorization, Origin:new URL(page.url()).origin}, data:body,
    });
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  }
  const answer = await cli('answer-put', [], {key, question, state:'confirmed', value:savedValue});
  await page.reload();
  await page.getByRole('button', {name:'Answers', exact:true}).click();
  const search = page.getByLabel('Find answers', {exact:true});
  const searchButton = page.getByRole('button', {name:'Search answers', exact:true});
  const card = page.getByRole('button', {name:question, exact:true});
  const value = page.getByLabel('Answer value', {exact:true});
  await search.fill(question);
  await searchButton.click();
  await card.click();
  assert.equal(await value.inputValue(), savedValue);
  await value.fill('Unsaved lifecycle answer draft');
  const trashed = await cli('answer-trash', args(key, answer.revision));
  assert.equal(trashed.revision, answer.revision + 1);
  assert.equal(typeof trashed.deletedAt, 'string');
  assert.equal(await value.inputValue(), 'Unsaved lifecycle answer draft');
  await searchButton.click();
  await card.waitFor({state:'hidden'});
  assert.equal(await value.inputValue(), 'Unsaved lifecycle answer draft');
  const beforeList = await readFile(join(root, 'answers.json'), 'utf8');
  const listed = await cli('trash-list');
  assert.deepEqual(await api('/api/trash'), listed);
  assert.equal(await readFile(join(root, 'answers.json'), 'utf8'), beforeList);
  assert.deepEqual(listed.items.find(item => item.type === 'answer' && item.id === key), {
    type:'answer', id:key, revision:trashed.revision, deletedAt:trashed.deletedAt,
    label:question, state:'confirmed', reviewStatus:'accepted', blockerCounts:{sessions:0, history:0},
  });
  assert.equal(JSON.stringify(listed).includes(savedValue), false);
  const encodedRestore = `/api/answers/by-key/${Buffer.from(key, 'utf8').toString('base64url')}/restore`;
  const restored = await api(encodedRestore, {expectedRevision:trashed.revision});
  assert.equal(restored.revision, trashed.revision + 1);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.value, savedValue);
  assert.equal(await value.inputValue(), 'Unsaved lifecycle answer draft');
  // Return the draft to its original value before leaving the editor.
  await value.fill(savedValue);
  await page.reload();
  await page.getByRole('button', {name:'Answers', exact:true}).click();
  await search.fill(question);
  await searchButton.click();
  await card.click();
  assert.equal(await value.inputValue(), savedValue);
  const again = await api(route(key, 'trash'), {expectedRevision:restored.revision});
  const cliRestored = await cli('answer-restore', args(key, again.revision));
  assert.equal(cliRestored.revision, again.revision + 1);
  assert.equal(cliRestored.deletedAt, null);
  assert.equal(cliRestored.value, savedValue);
  const finalTrash = await api(route(key, 'trash'), {expectedRevision:cliRestored.revision});
  assert.deepEqual(await api(route(key, 'delete'), {expectedRevision:finalTrash.revision}), {deleted:true, key});
  const afterDelete = await readFile(join(root, 'answers.json'), 'utf8');
  assert.deepEqual(await cli('answer-delete', args(key, finalTrash.revision)), {deleted:false, key});
  assert.equal(await readFile(join(root, 'answers.json'), 'utf8'), afterDelete);
  assert.equal(Object.hasOwn(JSON.parse(afterDelete).answers, key), false);
  assert.equal((await api('/api/trash')).items.some(item => item.type === 'answer' && item.id === key), false);
  await page.reload();
  await page.getByRole('button', {name:'Answers', exact:true}).click();
  await search.fill(question);
  await searchButton.click();
  await page.getByText('No matching answers.', {exact:true}).waitFor();
  assert.equal(await card.count(), 0);

  const sensitive = await cli('answer-put', ['--remember-sensitive'], {key:sensitiveKey,
    question:`Sensitive lifecycle browser answer ${suffix}?`, state:'sensitive', value:privateValue});
  const hiddenTrash = await api(route(sensitiveKey, 'trash'), {expectedRevision:sensitive.revision});
  const hiddenRestore = await cli('answer-restore', args(sensitiveKey, hiddenTrash.revision));
  for (const projection of [sensitive, hiddenTrash, hiddenRestore]) {
    assert.equal(projection.valueRedacted, true);
    assert.equal(Object.hasOwn(projection, 'value'), false);
    assert.equal(JSON.stringify(projection).includes(privateValue), false);
  }
  const sensitiveTrash = await cli('answer-trash', args(sensitiveKey, hiddenRestore.revision));
  const sensitiveList = await api('/api/trash');
  assert.equal(sensitiveList.items.some(item => item.type === 'answer' && item.id === sensitiveKey), true);
  assert.equal(JSON.stringify(sensitiveList).includes(privateValue), false);
  assert.deepEqual(await api(route(sensitiveKey, 'delete'), {expectedRevision:sensitiveTrash.revision}),
    {deleted:true, key:sensitiveKey});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  return {cliTrashApiRestore:true, unicodeByKeyRestore:true, apiTrashCliRestore:true, externalDraftPreserved:true,
    redactedListingAgreement:true, listingReadOnly:true, sensitiveProjection:true,
    apiDeleteCliMissingNoop:true, canonicalReloadAbsence:true, pythonAbsentFromPath:true};
}
