import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

async function moduleUrl(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  let emitted = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  for (const [specifier, url] of Object.entries(replacements)) {
    emitted = emitted.replaceAll(`from "${specifier}"`, `from "${url}"`)
      .replaceAll(`from '${specifier}'`, `from '${url}'`);
  }
  return `data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`;
}
const modelUrl = await moduleUrl('../apps/companion/components/browser-recovery-model.ts');
const hookUrl = await moduleUrl('../apps/companion/components/projection-view.ts', { react: import.meta.resolve('react') });
const viewUrl = await moduleUrl('../apps/companion/components/BrowserRecovery.tsx', {
  './browser-recovery-model': modelUrl,
  './projection-view': hookUrl,
  'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
});
const { browserRecoveryProjection: parse } = await import(modelUrl);
const { BrowserRecoveryView: View } = await import(viewUrl);
const ready = { available: true, guidance: {
  status: 'ready', hotOperationCount: 3, archivedOperationCount: 64,
  archiveSegmentsRemaining: 31, nextAction: 'continue',
} };
const projection = changes => parse(JSON.stringify({ ...ready, guidance: { ...ready.guidance, ...changes } }));
const render = props => renderToStaticMarkup(createElement(View, {
  data: projection({}), loading: false, error: '', refresh() {}, ...props,
}));

test('browser recovery accepts only matching status/actions and safe nonnegative counts', () => {
  assert.deepEqual(projection({}), ready);
  assert.deepEqual(parse('{"available":false,"reason":"unsupported_store"}'), {
    available: false, reason: 'unsupported_store',
  });
  for (const status of ['reconciliation_required', 'capacity_reached', 'unknown']) {
    assert.throws(() => projection({ status }));
  }
  for (const key of ['hotOperationCount', 'archivedOperationCount', 'archiveSegmentsRemaining']) {
    for (const value of [-1, 1.5, '1', true, null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => projection({ [key]: value }));
    }
  }
  for (const value of [null, [], {}, { available: true }, { available: false, reason: 'empty' }]) {
    assert.throws(() => parse(JSON.stringify(value)));
  }
});

test('browser recovery strips private identities and arbitrary response contents', () => {
  const value = { ...ready, claim: 'private-capability', guidance: {
    ...ready.guidance, unresolvedOperationId: 'private-operation', value: 'private-answer',
  } };
  const parsed = parse(JSON.stringify(value));
  assert.deepEqual(parsed, ready);
  assert.doesNotMatch(JSON.stringify(parsed), /private-/);
  assert.doesNotMatch(render({ data: parsed }), /private-/);
});

test('uncertain result explains workspace barrier, protected readback, and draft-preserving handoff', () => {
  const html = render({ data: projection({ status: 'reconciliation_required', nextAction: 'reconcile_or_handoff' }) });
  assert.match(html, /uncertain outcome/);
  assert.match(html, /blocked across this workspace/);
  assert.match(html, /Keep the existing browser draft open/);
  assert.match(html, /Read-only reconciliation requires an active protected browser host/);
  assert.match(html, /stop automation and take over manually/);
  assert.match(html, /Review the existing form before changing it/);
  assert.match(html, /submit the application yourself/);
  assert.doesNotMatch(html, /No unresolved browser actions/);
});

test('capacity guidance stops writes without offering a reset, retry, or submit control', () => {
  const html = render({ data: projection({ status: 'capacity_reached', nextAction: 'handoff_capacity', archiveSegmentsRemaining: 0 }) });
  assert.match(html, /history is full/);
  assert.match(html, /Further automated changes are blocked/);
  assert.match(html, /preserve the browser draft/);
  assert.match(html, /Do not delete saved history or retry the write/);
  assert.match(html, /Recent actions/);
  assert.match(html, /Archived actions/);
  assert.match(html, /Archive batches remaining/);
  const buttons = [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(buttons, ['Refresh browser status']);
});

test('loading, unavailable, and errors never display earlier readiness as current', () => {
  for (const state of [{ loading: true }, { error: 'private server error' }, { data: null },
    { data: { available: false, reason: 'unsupported_store' } }]) {
    const html = render(state);
    assert.doesNotMatch(html, /No unresolved browser actions|Recent actions|private server error/);
  }
  assert.match(render({ loading: true }), /Checking saved browser actions/);
  assert.match(render({ error: 'failed' }), /role="alert"/);
  assert.match(render({ data: null }), /status is unavailable/);
  const html = render({});
  assert.match(html, /No unresolved browser actions are recorded/);
  assert.match(html, /does not confirm that a browser is connected or an action is approved/);
  assert.match(html, /Refreshing only reads saved status/);
});
