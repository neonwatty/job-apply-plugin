import {
  assert,
  readFile,
  join,
  test,
  REPO_ROOT,
} from "./workspace_test_support.mjs";

test("automation UI describes reviewed ATS support without exposing live execution", async () => {
  const html = await readFile(join(REPO_ROOT, "companion", "workspace", "index.html"), "utf8");
  const automation = await readFile(join(REPO_ROOT, "companion", "workspace", "features", "automation.js"), "utf8");
  assert.match(html, /Workday account automation remains unavailable until its reviewed canary passes/);
  assert.match(html, /value="manual">Manual account setup/);
  assert.doesNotMatch(html, /value="custom"|value="ask_each_time"/);
  assert.match(automation, /reviewed adapter is installed, but live support is unavailable/);
  assert.match(automation, /Shared password automation needs native secure setup/);
  assert.match(html, /Greenhouse applications need no account/);
  assert.doesNotMatch(html, /id="[^\"]*(?:execute|run-live|create-account)[^\"]*"/i);
});

test("application authority UI keeps bounded modes visible and final action manual", async () => {
  const root = join(REPO_ROOT, "companion", "workspace");
  const html = await readFile(join(root, "index.html"), "utf8");
  const controller = await readFile(join(root, "features", "automation.js"), "utf8");
  assert.match(html, /value="fill_to_review">Fill to Review/);
  assert.match(html, /value="campaign">Campaign/);
  assert.match(html, /Every mode stops before Final Submit or Send/);
  assert.match(html, /never grant permission to remember it/);
  assert.match(controller, /expectedRevision: current\?\.revision \?\? 0/);
  assert.match(controller, /\/api\/application-authority\/revoke/);
  assert.match(controller, /jobIds\.join\("\\n"\)/);
  assert.match(controller, /new Set\(active \? authority\.sensitiveFieldClasses/);
});
