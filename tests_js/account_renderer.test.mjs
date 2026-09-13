import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { protectedOutcome, emailOnlyOutcome, OUTCOMES } from "../qa/account_renderer/app.js";

test("synthetic account outcomes remain pending until native effect and non-final", () => {
  for (const [scenario, lifecycleState] of Object.entries(OUTCOMES)) {
    assert.deepEqual(protectedOutcome(scenario), { lifecycleState: "pending_native_effect", retryAllowed: false, finalActionAuthorized: false, secureControlCleared: false });
    assert.deepEqual(protectedOutcome(scenario, true), { lifecycleState, retryAllowed: false, finalActionAuthorized: false, secureControlCleared: true });
  }
});

test("renderer contains one native-only secure control and no submission form", async () => {
  const html = await readFile(new URL("../qa/account_renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /id="job-apply-secure-control" type="password"/);
  assert.doesNotMatch(html, /<form|XMLHttpRequest/i);
  assert.doesNotMatch(html, /effect|capability/i);
  assert.match(html, /role="status"/);
});

test("renderer reports only value-free observed evidence", async () => {
  const source = await readFile(new URL("../qa/account_renderer/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|body\s*:|localStorage|sessionStorage|document\.cookie/i);
});

test("Oracle email-only renderer binds exact consent and one non-final Next", async () => {
  const html = await readFile(new URL("../qa/account_renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /id="job-apply-email-control" type="email"/);
  assert.match(html, /id="job-apply-focus-decoy" type="button"/);
  assert.match(html, /id="oracle-form:v1" aria-label="Oracle candidate profile account form"/);
  assert.match(html, /id="job-apply-terms-control" type="checkbox"/);
  assert.match(html, /id="job-apply-terms-document"/);
  assert.match(html, /id="job-apply-next-control" type="button"/);
  assert.match(html, /id="job-apply-final-tripwire" type="button" disabled/);
  assert.deepEqual(emailOnlyOutcome("success", true), {
    lifecycleState: "active", retryAllowed: false, finalActionAuthorized: false,
    credentialProviderInvocations: 0, nextActivations: 1, emailRemoved: true,
  });
  assert.equal(emailOnlyOutcome("ambiguity", true).retryAllowed, false);
});
