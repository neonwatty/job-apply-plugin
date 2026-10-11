import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { controlFingerprint } from '../runtime/integrations/browser/contract.js';
import { LocalFixtureBrowserAdapter } from '../runtime/integrations/browser/local-fixture-adapter.js';

const controls = [
  { id: 'contact.name', kind: 'fill', selector: '#name' },
  { id: 'resume.file', kind: 'upload', selector: '#resume' },
  { id: 'submit', kind: 'final', selector: '#submit' },
];
const html = `<!doctype html><title>Controlled application fixture</title>
<form id="application"><label>Name<input id="name" type="text"></label>
<label>Draft notes<textarea id="notes"></textarea></label>
<label>Resume<input id="resume" type="file"></label><button id="submit" type="submit">Submit</button></form>
<script>globalThis.fixtureSubmissions=0;globalThis.fixtureWrites=0;
document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();fixtureSubmissions++});
document.querySelector('#name').addEventListener('input',()=>fixtureWrites++);</script>`;

/** All conditional checks and the DOM effect execute in this one synchronous browser call. */
function exchange(input) {
  if (location.origin !== input.origin) throw Error('fixture_origin_changed');
  const key = '__jobApplyControlledFixture';
  let state = globalThis[key];
  if (!state) {
    state = { documentId: crypto.randomUUID(), revision: 1n, dirty: false, finalAction: 'untouched',
      identities: new WeakMap(), nextIdentity: 1, signature: null, configuration: JSON.stringify(input.controls) };
    state.observer = new MutationObserver(() => { state.dirty = true; });
    state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    document.addEventListener('input', () => { state.dirty = true; }, true);
    document.addEventListener('change', () => { state.dirty = true; }, true);
    document.addEventListener('submit', () => { state.finalAction = 'activated'; state.dirty = true; }, true);
    document.addEventListener('click', event => {
      const final = input.controls.find(control => control.kind === 'final');
      if (final && event.target.closest(final.selector)) { state.finalAction = 'activated'; state.dirty = true; }
    }, true);
    globalThis[key] = state;
  }
  if (state.configuration !== JSON.stringify(input.controls)) throw Error('fixture_mapping_changed');
  const identity = node => {
    if (!node) return 0;
    if (!state.identities.has(node)) state.identities.set(node, state.nextIdentity++);
    return state.identities.get(node);
  };
  const form = document.querySelector('#application');
  if (!form || form.tagName !== 'FORM') throw Error('fixture_form_unavailable');
  const current = () => {
    if (state.observer.takeRecords().length) state.dirty = true;
    const nodes = [...form.querySelectorAll('*')];
    // Snapshot all draft controls, including those the host is not allowed to fill.
    const signature = JSON.stringify([identity(form), form.outerHTML, nodes.map(node =>
      [identity(node), node.value ?? null, node.disabled ?? null, node.readOnly ?? null]), state.finalAction]);
    if (state.signature !== null && (state.signature !== signature || state.dirty)) state.revision++;
    state.signature = signature;
    state.dirty = false;
    const observed = input.controls.map(control => {
      const node = document.querySelector(control.selector);
      const supported = node && node.form === form && !node.matches(':disabled') && !node.readOnly
        && (control.kind !== 'fill' || node.tagName === 'INPUT' && ['text', 'email', 'tel'].includes(node.type));
      return { id: control.id, kind: control.kind,
        state: !supported ? 'unavailable' : node.value ? 'complete' : 'empty' };
    });
    return { evidenceKind: 'synthetic_adapter', observationRevision: String(state.revision), controls: observed,
      form: { documentId: state.documentId, formId: `fixture-form-${identity(form)}`,
        origin: location.origin, controlSetFingerprint: input.fingerprint }, finalAction: state.finalAction };
  };
  const observed = current();
  if (input.action === 'observe') return observed;
  const control = input.controls.find(item => item.id === input.controlId);
  const node = control && document.querySelector(control.selector);
  const available = control?.kind === 'fill' && observed.controls.find(item => item.id === control.id)?.state !== 'unavailable';
  if (input.action === 'readback') return { observation: observed,
    effect: !available ? 'unavailable' : node.value === input.value ? 'matches' : 'differs' };
  const expected = input.expected;
  if (JSON.stringify(observed.form) !== JSON.stringify(expected.form)
    || observed.observationRevision !== expected.observationRevision || observed.finalAction !== 'untouched') {
    return { status: 'not_applied', reason: 'scope_changed' };
  }
  if (!available) return { status: 'not_applied', reason: 'control_unavailable' };
  // Native setter and synchronous events occur after comparison, without an asynchronous browser gap.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, input.value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  current();
  return { status: 'applied' };
}

export async function localBrowserFixture(t) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  // A fresh private context can visit only this test's loopback origin.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  const driver = () => {
    const run = payload => page.evaluate(exchange, { ...payload, origin, controls, fingerprint: controlFingerprint(controls) });
    return { observe: () => run({ action: 'observe' }),
      compareAndFill: payload => run({ action: 'fill', ...payload }),
      readback: (controlId, value) => run({ action: 'readback', controlId, value }) };
  };
  const adapter = (port = driver()) => new LocalFixtureBrowserAdapter(port, origin,
    new Map([['contact.name', { valueRef: 'profile.name', value: 'UNRELATED PRIVATE PROFILE' }]]));
  return { browser, page, origin, driver, adapter };
}
