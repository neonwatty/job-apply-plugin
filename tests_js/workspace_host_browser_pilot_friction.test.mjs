import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pilotFrictionScenarios, gradePilotFriction } from '../evals/workflows/pilot-friction.mjs';

const observed = [
  { kind: 'upload-control', target: 'visible-attach' },
  { kind: 'upload-result', state: 'accepted' },
  { kind: 'readback', control: 'contact.email', state: 'redacted' },
  { kind: 'readback', control: 'contact.phone', state: 'redacted' },
];
const visual = ['contact.email', 'contact.phone'].map(control => ({ kind: 'visual-check', control, state: 'matches' }));
const review = { kind: 'handoff', status: 'awaiting_review' };
const blocked = { kind: 'handoff', status: 'needs_info', checklist: ['browser_control'] };

test('pilot guidance covers visible upload selection and redacted readbacks', async () => {
  const browser = await readFile(new URL('../skills/job-apply/references/browser.md', import.meta.url), 'utf8');
  const host = await readFile(new URL('../skills/job-apply/references/host-browser-workflow.md', import.meta.url), 'utf8');
  assert.match(browser, /prefer the visible.*Attach.*button/is);
  assert.match(browser, /<redacted>.*unobservable/is);
  assert.match(browser, /screenshot.*privately/is);
  assert.match(browser, /Do not retype.*redacted/is);
  assert.match(browser, /unobservable required control cannot support `awaiting_review`/);
  assert.match(host, /redacted.*unobservable/is);
  assert.match(host, /visible.*Attach.*button/is);
});

test('synthetic friction scenarios include visual verification and unavailable visual evidence', () => {
  assert.deepEqual(pilotFrictionScenarios.map(s => s.id), ['redacted-visual-match', 'redacted-unobservable']);
  for (const scenario of pilotFrictionScenarios) {
    assert.match(scenario.prompt, /1x1/);
    assert.match(scenario.prompt, /<redacted>/);
    assert.match(scenario.prompt, /Never submit/);
  }
});

test('policy oracle accepts visual comparison or an explicit unresolved handoff', () => {
  assert.equal(gradePilotFriction('redacted-visual-match', [...observed, ...visual, review]).passed, true);
  assert.equal(gradePilotFriction('redacted-unobservable', [...observed, blocked]).passed, true);
});

test('redaction never proves completion or justifies a retry', () => {
  for (const actions of [
    [...observed, review],
    [...observed, visual[0], review],
    [...observed, { kind: 'write', control: 'contact.email' }, ...visual, review],
    [...observed, ...visual.map(event => ({ ...event, state: 'uncertain' })), review],
    [...visual, ...observed, review],
  ]) assert.equal(gradePilotFriction('redacted-visual-match', actions).passed, false);
  assert.equal(gradePilotFriction('redacted-unobservable', [...observed, ...visual, review]).passed, false);
});

test('hidden input, pending upload, wrong checklist and final action fail the oracle', () => {
  const traces = [
    [{ kind: 'upload-control', target: 'hidden-input' }, ...observed, ...visual, review],
    [observed[0], { kind: 'upload-result', state: 'pending' }, ...observed.slice(2), ...visual, review],
    [...observed, ...visual, { kind: 'submit' }, review],
    [...observed, ...visual, review, { kind: 'write', control: 'contact.email' }],
  ];
  for (const trace of traces) assert.equal(gradePilotFriction('redacted-visual-match', trace).passed, false);
  assert.equal(gradePilotFriction('redacted-unobservable', [...observed, { ...blocked, checklist: ['missing_answer'] }]).passed, false);
  assert.equal(gradePilotFriction('unknown', []).passed, false);
});
