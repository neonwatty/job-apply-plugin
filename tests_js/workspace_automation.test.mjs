import {
  assert,
  readFile,
  join,
  test,
  REPO_ROOT,
} from "./workspace_test_support.mjs";

test("automation UI describes reviewed ATS support without exposing live execution", async () => {
  const html = await readFile(join(REPO_ROOT, "workspace", "index.html"), "utf8");
  assert.match(html, /Workday seam remains disabled/);
  assert.match(html, /Greenhouse applications need no account/);
  assert.doesNotMatch(html, /id="[^\"]*(?:execute|run-live|create-account)[^\"]*"/i);
});
