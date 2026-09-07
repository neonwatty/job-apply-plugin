import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';

test('helper browser contract: emitted modules load and preserve browser-native behavior', { timeout: 30000 }, async (t) => {
  const paths = ['workspace/lib/helpers.js', ...['answer', 'activity', 'profile', 'resume', 'trash']
    .map(group => `runtime/workspace-ui/lib/${group}-view.js`)];
  const modules = new Map(await Promise.all(paths.map(async path => [
    `/${path}`, await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
  ])));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const unexpected = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://helper-contract.test') {
      unexpected.push(url.href);
      return route.abort();
    }
    if (url.pathname === '/') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Synthetic helper contract</title>',
    });
    if (modules.has(url.pathname)) return route.fulfill({
      contentType: 'text/javascript', body: modules.get(url.pathname),
    });
    unexpected.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto('http://helper-contract.test/');
  const result = await page.evaluate(async () => {
    const original = await import('/workspace/lib/helpers.js');
    const compiled = Object.assign({}, ...await Promise.all(
      ['answer', 'activity', 'profile', 'resume', 'trash']
        .map(group => import(`/runtime/workspace-ui/lib/${group}-view.js`)),
    ));
    function observe(h) {
      const payload = { retained: true };
      const patch = h.patchForPaths([['/a', payload], ['/a/b', 2]]);
      const current = { id: 'synthetic', revision: 2 };
      const incoming = { id: 'synthetic', revision: 2 };
      return {
        encoded: h.answerApiPath('é😀', 'reveal'),
        surrogate: h.answerApiPath('\ud800'),
        hidden: h.answerSummary({ valueRedacted: true, hasValue: true }),
        falsyDialog: h.canApplyAnswerDialogMutation(null, null, 1, 1, 0),
        scope: h.sameAnswerScope({ b: [, 1], a: NaN }, { a: null, b: [null, 1] }),
        alias: patch.a === payload && payload.b === 2,
        tags: h.tagsFromInput(' a, ,b,a '),
        prototypeLookup: h.transitionsFor('toString') === Object.prototype.toString,
        newestIdentity: h.newestCanonicalJob(current, incoming) === incoming,
        jobs: h.filterJobs([{ role: 'Engineer' }, { role: 'Other' }], ' ENGINE '),
        resume: h.resumeAssignmentText({ assignedJobCount: 1, implicitJobCount: 2 }),
        trash: h.typedDeletePhrase('resume'),
      };
    }
    return {
      originalExports: Object.keys(original).filter(name => name !== 'fileToBase64').sort(),
      compiledExports: Object.keys(compiled).sort(),
      original: observe(original), compiled: observe(compiled),
      // This is an original-only browser reference for the still-unported IO helper.
      fileReference: await original.fileToBase64(new File([new Uint8Array([0, 255, 128])], 'synthetic.bin')),
      nodeGlobals: typeof process,
    };
  });
  assert.deepEqual(result.compiledExports, result.originalExports);
  assert.equal(result.compiledExports.length, 35);
  assert.deepEqual(result.compiled, result.original);
  assert.deepEqual(result.compiled, {
    encoded: '/api/answers/by-key/w6nwn5iA/reveal', surrogate: '/api/answers/by-key/77-9',
    hidden: 'Sensitive value hidden — reveal explicitly to view', falsyDialog: 0,
    scope: true, alias: true, tags: ['a', 'b', 'a'], prototypeLookup: true,
    newestIdentity: true, jobs: [{ role: 'Engineer' }],
    resume: '1 explicitly assigned active job; 2 active jobs use this default.',
    trash: 'DELETE RESUME',
  });
  assert.equal(result.fileReference, 'AP+A');
  assert.equal(result.nodeGlobals, 'undefined');
  assert.deepEqual(unexpected, []);
  t.diagnostic(`Chromium ${browser.version()}; 35 inert exports; no application or Store launched`);
});
