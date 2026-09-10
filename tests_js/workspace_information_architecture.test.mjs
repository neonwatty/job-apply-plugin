import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const readWorkspaceFiles = async () => Promise.all([
  readFile(join(REPO_ROOT, "companion", "workspace", "index.html"), "utf8"),
  readFile(join(REPO_ROOT, "companion", "workspace", "styles.css"), "utf8"),
  Promise.all([
    readFile(join(REPO_ROOT, "companion", "workspace", "features", "bindings.js"), "utf8"),
    readFile(join(REPO_ROOT, "companion", "workspace", "features", "navigation.js"), "utf8"),
  ]).then((parts) => parts.join("\n")),
]);

function groupMarkup(html, id) {
  const match = html.match(new RegExp(
    `<div class="nav-group" role="group" aria-labelledby="${id}">([\\s\\S]*?)</div>\\s*</div>`,
  ));
  assert.ok(match, `missing navigation group ${id}`);
  return match[1];
}

test("global navigation exposes the pipeline, application data, and controls model", async () => {
  const [html] = await readWorkspaceFiles();
  const expectedGroups = [
    ["nav-group-pipeline", "Pipeline", ["nav-overview", "nav-jobs", "nav-attention"]],
    ["nav-group-application-data", "Application Data", ["nav-facts", "nav-resumes", "nav-answers"]],
    ["nav-group-controls", "Controls", ["nav-automation", "nav-trash"]],
  ];

  let priorPosition = -1;
  for (const [groupId, label, buttonIds] of expectedGroups) {
    const position = html.indexOf(`id="${groupId}"`);
    assert.ok(position > priorPosition, `${label} group is in the expected order`);
    priorPosition = position;
    assert.match(html, new RegExp(`<button id="${groupId}" class="nav-group-label"[^>]*>${label} `));
    const markup = groupMarkup(html, groupId);
    assert.deepEqual(
      [...markup.matchAll(/<button id="([^"]+)"/g)].map((match) => match[1]).filter(id => id !== groupId),
      buttonIds,
      `${label} contains only its assigned destinations`,
    );
  }
});

test("navigation preserves button, badge, active-state, and event-binding contracts", async () => {
  const [html, , app] = await readWorkspaceFiles();
  const destinations = [
    ["overview", "Overview"],
    ["jobs", "Jobs"],
    ["attention", "Needs Attention"],
    ["facts", "Facts"],
    ["resumes", "Resumes"],
    ["answers", "Answers"],
    ["automation", "Automation"],
    ["trash", "Trash"],
  ];

  for (const [name, label] of destinations) {
    const buttons = [...html.matchAll(new RegExp(`<button id="nav-${name}"[^>]*>([\\s\\S]*?)</button>`, "g"))];
    assert.equal(buttons.length, 1, `nav-${name} remains unique`);
    assert.match(buttons[0][1], new RegExp(`^${label}(?:\\s|<|$)`));
    assert.ok(
      app.includes(`$("#nav-${name}").addEventListener("click", () => navigateWorkspace("${name}"))`),
      `nav-${name} keeps its event binding`,
    );
  }

  assert.match(html, /id="nav-overview" class="nav-link active" type="button" aria-current="page"/);
  assert.match(html, /id="attention-nav-count" aria-label="attention count">0</);
  assert.match(html, /id="trash-nav-count" aria-label="trashed records">0</);
  assert.ok(app.includes('for (const section of ["overview", "jobs", "attention", "facts", "resumes", "answers", "automation", "trash"])'));
  assert.ok(app.includes('$(`#nav-${section}`).classList.toggle("active", active)'));
  assert.ok(app.includes('setAttribute("aria-current", "page")'));
});

test("persistent trust context explains local data and human control", async () => {
  const [html] = await readWorkspaceFiles();
  assert.match(html, /id="workspace-trust-context" class="trust-context">Your canonical data stays local\./);
  assert.match(html, /You direct changes and submissions; agents assist from the same record\./);
  assert.match(html, /<nav id="workspace-navigation" class="workspace-nav" aria-label="Workspace sections" aria-describedby="workspace-trust-context">/);
});

// Responsive sticky navigation is exercised in workspace_navigation_preview.test.mjs.
