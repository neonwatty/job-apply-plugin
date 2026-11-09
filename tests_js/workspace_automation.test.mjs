import {
  assert,
  readFile,
  join,
  test,
  REPO_ROOT,
} from "./workspace_test_support.mjs";

test("automation UI preserves application authority without account controls or live execution", async () => {
  const html = await readFile(join(REPO_ROOT, "workspace", "index.html"), "utf8");
  const automation=html.match(/<div id="automation-workspace"[\s\S]*?<\/div>\s*<\/main>/)?.[0] ?? '';
  assert.match(automation, /Application automation/);
  assert.match(automation, /Approve exact non-final field operations/);
  assert.doesNotMatch(automation, /employer portal|account operation recovery|signup email/i);
  assert.doesNotMatch(html, /id="[^\"]*(?:execute|run-live|create-account)[^\"]*"/i);
});
