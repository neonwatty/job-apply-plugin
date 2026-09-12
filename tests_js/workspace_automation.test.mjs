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
