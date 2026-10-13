import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { uploadManagedResume } from '../apps/companion/resume-upload.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const chooser = { async setFiles(paths) { calls.push(['files', paths]); } };
  const control = {
    async count() { return 1; }, async isVisible() { return true; },
    async click() { calls.push('click'); }, ...overrides.control,
  };
  const tab = { playwright: { waitForEvent() { calls.push('listen'); return Promise.resolve(chooser); } } };
  Object.assign(tab.playwright, overrides.playwright);
  const guard = async () => { calls.push('guard'); return { ok: true, path: '/private/managed.pdf' }; };
  return { calls, tab, control, guard: overrides.guard ?? guard };
}

test('guard precedes listener and click; successful selection still requires ATS observation', async () => {
  const f = fixture();
  assert.deepEqual(await uploadManagedResume(f), { outcome: 'selection_attempted', next: 'observe_widget' });
  assert.deepEqual(f.calls, ['guard', 'listen', 'click', ['files', ['/private/managed.pdf']]]);
});

test('chooser rejection while click is pending cannot reset the host kernel', async () => {
  const f = fixture({
    playwright: { waitForEvent() { return Promise.reject(new Error('private diagnostic')); } },
    control: { async click() { await delay(20); } },
  });
  assert.deepEqual(await uploadManagedResume(f), { outcome: 'chooser_unavailable', next: 'inspect_widget' });
});

test('duplicate or missing control never arms a listener or opens a chooser', async () => {
  for (const count of [0, 2]) {
    const f = fixture({ control: { async count() { return count; } } });
    assert.equal((await uploadManagedResume(f)).outcome, 'control_unavailable');
    assert.deepEqual(f.calls, []);
  }
});

test('hidden control and failed guard never click', async () => {
  for (const overrides of [
    { control: { async isVisible() { return false; } } },
    { guard: async () => ({ ok: false }) },
    { guard: async () => { throw new Error('private path'); } },
  ]) {
    const f = fixture(overrides);
    assert.notEqual((await uploadManagedResume(f)).outcome, 'selection_attempted');
    assert.deepEqual(f.calls, []);
  }
});

test('click failure drains listener and never uploads even when chooser resolves', async () => {
  const f = fixture({ control: { async click() { throw new Error('selector contains private data'); } } });
  assert.deepEqual(await uploadManagedResume(f), { outcome: 'click_failed', next: 'inspect_widget' });
  assert.deepEqual(f.calls, ['guard', 'listen']);
});

test('setFiles failure is unresolved and never retried or reported as accepted', async () => {
  let selections = 0;
  const f = fixture({ playwright: { waitForEvent() { return Promise.resolve({
    async setFiles() { selections++; throw new Error('secret path'); },
  }); } } });
  assert.deepEqual(await uploadManagedResume(f), { outcome: 'selection_uncertain', next: 'inspect_widget' });
  assert.equal(selections, 1);
});

test('synthetic embedded ATS with duplicate Attach names accepts one managed file', async t => {
  // Separate headless browser and synthetic bytes; never reuse an owner profile.
  const directory = await mkdtemp(join(tmpdir(), 'upload-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'synthetic.pdf');
  await writeFile(path, '%PDF-1.4\nsynthetic fixture only');
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<iframe id="application"></iframe>');
  const frame = page.frames()[1];
  await frame.setContent(`<fieldset aria-label="Resume/CV*">
    <button type="button" onclick="document.getElementById('resume').click()">Attach</button>
    <input id="resume" type="file" aria-label="Attach" style="width:1px;height:1px;opacity:0"
      onchange="document.getElementById('accepted').textContent=this.files[0].name">
    <output id="accepted"></output></fieldset><button id="submit">Submit application</button>`);
  const group = page.frameLocator('#application').getByRole('group', { name: 'Resume/CV*', exact: true });
  assert.equal(await group.getByRole('button', { name: 'Attach', exact: true }).count(), 2);
  const button = group.locator('button', { hasText: 'Attach' });
  // Translate only timeout option spelling; operations use real Playwright.
  const tab = { playwright: { waitForEvent: (event, { timeoutMs }) => page.waitForEvent(event, { timeout: timeoutMs }) } };
  const control = { count: () => button.count(), isVisible: () => button.isVisible(),
    click: ({ timeoutMs }) => button.click({ timeout: timeoutMs }) };
  assert.equal((await uploadManagedResume({ tab, control,
    guard: async () => ({ ok: true, path }) })).outcome, 'selection_attempted');
  assert.equal(await frame.locator('#accepted').textContent(), 'synthetic.pdf');
  assert.equal(await frame.locator('#resume').evaluate(input => input.files.length), 1);
});
