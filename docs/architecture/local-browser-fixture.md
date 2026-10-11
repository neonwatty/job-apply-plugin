# Controlled local browser integration

The experimental browser workflow can exercise a real Chromium document through
`LocalFixtureBrowserAdapter`. Its evidence remains `synthetic_adapter`: the page,
applicant values, approval source, and Store are fixtures. This is not an ATS
integration or proof of human authentication.

## File ownership and boundary

- `src/integrations/browser/local-fixture-adapter.ts` owns immutable
  control-to-value-reference mappings and loopback-origin checks. It exposes the
  existing `BrowserAdapter` interface to the protected workflow host.
- `src/integrations/browser/local-fixture-page.ts` defines the injected trusted
  page port. Runtime modules have no Playwright dependency.
- `tests_js/workspace_local_browser_support.mjs` implements that port with the
  repository's pinned Playwright, a fresh headless Chromium context, and a server
  bound to `127.0.0.1`. Requests outside that fixture origin are blocked.
- `tests_js/workspace_local_browser_adapter.test.mjs` exercises conditional fills,
  stale observations, interrupted readback, replay, mapping restrictions, and
  preserved drafts.
- `tests_js/workspace_local_browser_host.test.mjs` composes the driver with the
  protected workflow host, `BrowserWorkflowBroker`, and canonical native Store.

The parent host retains its private approval port and canonical grants. Model
requests carry opaque control/value references. The driver retains selectors and
fictional field values; observations and durable receipts never contain them.
Only text, email, and telephone input fills are supported. Uploads and final
submission are unavailable through this adapter.

## Conditional browser writes

A page observation includes a document identity, form identity, control identity
fingerprint, monotonically advancing revision, control state, and final-action
state. The fixture driver observes all form draft controls, including controls
outside the host's allowed mapping. Events, DOM changes, replaced nodes, and
changed field values invalidate an earlier observation. Reload creates a new
document identity.

The driver compares the full expected identity and revision and performs the fill
in a single synchronous browser execution turn. It uses the native input setter
and dispatches input/change events. Readback compares the intended value privately
and lets the durable boundary verify the resulting observation. A browser reply
lost after a write leaves durable uncertainty; another write remains blocked.

This conditional driver is trusted fixture infrastructure. Page-resident state
is not a security boundary against hostile website scripts. The production host
would need equivalent trusted conditional-write behavior and authenticated human
approval routing before any real ATS use.

## Restart and recovery evidence

Tests replace the adapter, protected host, and broker objects while Chromium and
the fixture Store survive. Readback then reconciles the original canonical intent
with current recovered claim authority, preserving the operation fingerprint and
all unrelated browser drafts. Replay and repeated reconciliation do not fill
again. Changed field values remain untouched and uncertain; revoked authority
cannot reconcile an old operation.

This is in-process host replacement, not an operating-system process crash test.
A browser reload invalidates old observation identity; it does not claim to restore
a destroyed document's draft. The fixture final-action test invokes a local
prevented submit to verify that subsequent automation stops. Automation itself
never activates submit.

## Focused verification

```sh
node tools/build-runtime.mjs
node --test tests_js/workspace_local_browser_adapter.test.mjs tests_js/workspace_local_browser_host.test.mjs
```

The native host case compiles the existing fixture lock addon and writes only a
temporary Store. Missing Chromium or native build requirements fail the test;
these checks do not silently count unavailable browser evidence as a pass.
