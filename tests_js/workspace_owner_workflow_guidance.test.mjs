import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../apps/companion/components/OwnerWorkflow.tsx', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText.replace('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve('react/jsx-runtime')).href));
const { OwnerWorkflow } = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`);

test('Companion renders exact selected job opt-in and experimental stop boundary without an action control', () => {
  const first = renderToStaticMarkup(React.createElement(OwnerWorkflow, { jobId: 'saved-job-one' }));
  const switched = renderToStaticMarkup(React.createElement(OwnerWorkflow, { jobId: 'saved-job-two<&' }));
  assert.match(first, /<code>saved-job-one<\/code>/u);
  assert.match(switched, /<code>saved-job-two&lt;&amp;<\/code>/u);
  assert.doesNotMatch(switched, /saved-job-one/u);
  for (const boundary of ['To opt in', 'current application run', 'confirmed managed resume',
    'code-provided actions and blockers', 'stops at Needs information', 'upload-through-review is not available yet',
    'does not authorize an action']) assert.ok(first.includes(boundary), boundary);
  assert.doesNotMatch(first, /<button|<form|<input|<a\s/u);
});
