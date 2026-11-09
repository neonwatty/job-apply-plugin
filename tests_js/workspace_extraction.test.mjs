import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCoordinators, createWorkspaceState } from "../workspace/lib/state.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FEATURE_NAMES = [
  "activity", "answers", "automation", "bindings", "facts",
  "jobs", "navigation", "overview", "resumes", "trash",
];

test("browser features consume one explicit context without sideways feature imports", async () => {
  for (const name of FEATURE_NAMES) {
    const source = await readFile(join(ROOT, "workspace", "features", `${name}.js`), "utf8");
    assert.match(source, new RegExp(`export function install${name[0].toUpperCase()}${name.slice(1)}\\(context\\)`));
    assert.match(source, /const \{ api, state: stores, dom, coordinators \} = context/);
    assert.doesNotMatch(source, /from ["']\.\/|from ["']\.\.\/features\//);
    assert.ok(source.split("\n").length <= 500, `${name}.js stays within the source limit`);
  }
});

test("workspace state is fresh per bootstrap and coordinators are not shared", () => {
  const first = createWorkspaceState();
  const second = createWorkspaceState();
  first.job.jobs.push({ id: "first" });
  first.profile.drafts.set("/firstName", "Private draft");
  assert.deepEqual(second.job.jobs, []);
  assert.equal(second.profile.drafts.size, 0);
  assert.notEqual(createCoordinators().overviewRefreshCoordinator, createCoordinators().overviewRefreshCoordinator);
});

test("server static assets remain an explicit closed allowlist", async () => {
  const server = await readFile(join(ROOT, "scripts", "job_apply_workspace", "__init__.py"), "utf8");
  for (const path of [
    "/app.js", "/bootstrap.js", "/lib/api.js", "/lib/dom.js", "/lib/helpers.js",
    "/lib/state.js", ...FEATURE_NAMES.map((name) => `/features/${name}.js`),
  ]) assert.match(server, new RegExp(`"${path.replaceAll("/", "\\/")}"`));
  assert.doesNotMatch(server, /rglob|glob\(|os\.walk|serve_directory|SimpleHTTPRequestHandler/);
});
