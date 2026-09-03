import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const readWorkspaceFiles = async () => Promise.all([
  readFile(join(REPO_ROOT, "workspace", "index.html"), "utf8"),
  readFile(join(REPO_ROOT, "workspace", "styles.css"), "utf8"),
  readFile(join(REPO_ROOT, "workspace", "app.js"), "utf8"),
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
    ["nav-group-application-data", "Application data", ["nav-facts", "nav-resumes", "nav-answers"]],
    ["nav-group-controls", "Controls", ["nav-automation", "nav-trash"]],
  ];

  let priorPosition = -1;
  for (const [groupId, label, buttonIds] of expectedGroups) {
    const position = html.indexOf(`id="${groupId}"`);
    assert.ok(position > priorPosition, `${label} group is in the expected order`);
    priorPosition = position;
    assert.match(html, new RegExp(`<span id="${groupId}" class="nav-group-label">${label}</span>`));
    const markup = groupMarkup(html, groupId);
    assert.deepEqual(
      [...markup.matchAll(/<button id="([^"]+)"/g)].map((match) => match[1]),
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
  assert.ok(app.includes('$(`#nav-${section}`).toggleAttribute("aria-current", active)'));
});

test("persistent trust context explains local data and human control", async () => {
  const [html] = await readWorkspaceFiles();
  assert.match(html, /id="workspace-trust-context" class="trust-context">Your canonical data stays local\./);
  assert.match(html, /You direct changes and submissions; agents assist from the same record\./);
  assert.match(html, /<nav class="workspace-nav" aria-label="Workspace sections" aria-describedby="workspace-trust-context workspace-nav-overflow-hint">/);
});

test("navigation has a collision-free row and focus-safe narrow-width overflow", async () => {
  const [html, css] = await readWorkspaceFiles();
  assert.match(html, /id="workspace-nav-overflow-hint" class="nav-overflow-hint">Scroll horizontally to explore all navigation groups/);
  assert.match(css, /\.topbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\) auto/);
  assert.match(css, /\.workspace-nav\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*display:\s*flex[^}]*width:\s*100%[^}]*min-width:\s*0/);
  assert.match(css, /\.connection\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1[^}]*justify-self:\s*end/);
  assert.match(css, /\.nav-group\s*\{[^}]*min-width:\s*max-content/);
  assert.match(css, /@media \(max-width:\s*1100px\)\s*\{[\s\S]*?\.workspace-nav\s*\{[^}]*overflow-x:\s*auto[^}]*overscroll-behavior-inline:\s*contain[^}]*scroll-padding-inline:\s*\.45rem[^}]*scroll-snap-type:\s*inline proximity/);
  assert.match(css, /@media \(max-width:\s*1100px\)\s*\{[\s\S]*?\.nav-link\s*\{[^}]*scroll-margin-inline:\s*\.45rem[^}]*scroll-snap-align:\s*center/);
  assert.match(css, /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.nav-overflow-hint\s*\{[^}]*display:\s*block/);
  assert.match(css, /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.connection\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*2[^}]*justify-self:\s*start/);
  assert.match(css, /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.workspace-nav\s*\{[^}]*scroll-snap-type:\s*inline mandatory/);
  assert.match(css, /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.nav-group\s*\{[^}]*flex:\s*0 0 calc\(100% - \.9rem\)[^}]*min-width:\s*0[^}]*scroll-snap-align:\s*start/);
  assert.match(css, /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.nav-link\s*\{[^}]*padding-inline:\s*\.35rem[^}]*scroll-snap-align:\s*none/);
});
