import {
  assert,
  readFile,
  join,
  resolve,
  test,
  REPO_ROOT,
} from "./workspace_test_support.mjs";

test("Companion markup exposes advisory readiness and safe review controls", async () => {
  const html = await readFile(join(REPO_ROOT, "workspace", "index.html"), "utf8");
  assert.match(html, /id="profile-readiness"/);
  assert.match(html, /Individual jobs may still require additional information\./);
  assert.match(html, /id="proposal-keep-all"[^>]*>Keep all current</);
  assert.match(html, /id="replacement-confirm-dialog"/);
  assert.doesNotMatch(html, /accept all extracted/i);
  assert.doesNotMatch(html, /application ready|readiness score|\d+%/i);
});


test("workspace markup has semantic dialogs, labels, live regions, and no remote assets", async () => {
  const html = await readFile(join(REPO_ROOT, "workspace", "index.html"), "utf8");
  const app = await readFile(join(REPO_ROOT, "workspace", "app.js"), "utf8");
  assert.match(html, /<main(?:\s|>)/);
  assert.match(html, /<dialog id="job-dialog" aria-labelledby=/);
  assert.match(html, /id="facts-workspace"/);
  assert.match(html, /id="attention-workspace"/);
  assert.match(html, /id="attention-live"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="attention-list"[^>]+role="list"[^>]+aria-busy="true"/);
  assert.match(html, /id="resumes-workspace"/);
  assert.match(html, /id="answers-workspace"/);
  assert.match(html, /<dialog id="answer-dialog" aria-labelledby=/);
  assert.match(html, /<dialog id="answer-merge-dialog" aria-labelledby=/);
  assert.match(html, /id="answer-merge-winner"/);
  assert.match(html, /id="answer-reveal"/);
  assert.match(html, /name="rememberSensitive"/);
  assert.match(html, /<dialog id="resume-dialog" aria-labelledby=/);
  assert.match(html, /<dialog id="proposal-dialog" aria-labelledby=/);
  assert.match(html, /aria-label="Workspace sections"/);
  for (const path of ["\/firstName", "\/location\/city", "\/workHistory", "\/education", "\/skills", "\/preferences\/targetTitles", "\/preferences\/minBaseSalary", "\/preferences\/remotePreference", "\/preferences\/excludePatterns", "\/preferences\/defaultTimeRange"]) {
    assert.match(html, new RegExp(`data-path="${path}"`));
  }
  assert.match(html, /data-path="\/location\/zip"/);
  assert.doesNotMatch(html, /data-path="\/location\/postalCode"/);
  assert.match(html, /data-path="\/preferences\/minBaseSalary" type="text"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /class="skip-link"/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  for (const name of ["url", "role", "company", "location", "priority", "resumeId", "notes", "description"]) {
    assert.match(html, new RegExp(`<(?:input|select|textarea) name="${name}"`));
  }
  assert.match(app, /activity-approval-fields"\)\.addEventListener\("change", invalidateGroupedApprovalPreview\)/);
  assert.match(app, /groupedApprovalProjectionSignature/);
  assert.match(app, /answerRevision: item\.answerRevision/);
  assert.match(app, /answerSensitivity: item\.answerSensitivity/);
  assert.match(app, /fieldClass: item\.fieldClass/);
  assert.match(app, /approvalsByReference\.get\(item\.reference\)/);
  assert.match(app, /approval\?\.currentUse === true/);
  assert.match(app, /\["personal", "high"\]\.includes\(item\.answerSensitivity\)/);
  assert.match(app, /groupedApprovalRequestSequence/);
  assert.match(app, /requestSequence !== state\.groupedApprovalRequestSequence/);
  assert.match(app, /item\.sensitive === true \|\| item\.state === "sensitive"/);
  assert.match(app, /Cleanup preview failed:/);
  assert.match(app, /proposal\.winnerQuestion/);
  assert.match(app, /proposal\.duplicateQuestion/);
  assert.match(app, /proposal\.winnerKey/);
  assert.match(app, /proposal\.duplicateKey/);
});


test("job-apply routes every ordinary URL through the canonical task protocol", async () => {
  const skill = await readFile(join(REPO_ROOT, "skills", "job-apply", "SKILL.md"), "utf8");
  const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
  assert.match(skill, /resume-import --input/);
  assert.match(skill, /resume-resolve --id <resume-id>/);
  assert.match(skill, /job-apply-task\.py[\s\S]{0,300}intake --input/);
  assert.match(skill, /job-apply-task\.py \.\.\. snapshot/);
  assert.match(skill, /select --id <job-id> --expected-revision <displayed-revision> --owner-confirmed/);
  assert.match(skill, /discard the pre-select displayed revision and retain the exact revision returned in `select\.job\.revision`/);
  assert.match(skill, /job-acquire --id <job-id> --owner <owner-label> --expected-revision <select\.job\.revision>/);
  assert.match(skill, /other non-success result stops without browser work; do not run `job-acquire`/);
  assert.match(skill, /Never infer a choice from priority/);
  assert.match(skill, /use the acquired canonical job ID as the application\/session ID/);
  assert.doesNotMatch(skill, /direct-URL mode|URL-derived application\/session ID/);
  assert.match(skill, /Never use `profile\.resumePath`, a URL-derived session ID, or a user source path for upload/);
  assert.doesNotMatch(readme, /Every resume write uses an exact revision/);
  assert.match(readme, /Import is a new-record operation protected by ID\/content uniqueness/);
  assert.match(readme, /resume-resolve/);
  assert.match(readme, /scripts\/job-apply-task\.py/);
});

test("skill and documentation contracts keep extraction agent-owned and context-bounded", async () => {
  const jobApply = await readFile(join(REPO_ROOT, "skills", "job-apply", "SKILL.md"), "utf8");
  const workspaceSkill = await readFile(join(REPO_ROOT, "skills", "job-workspace", "SKILL.md"), "utf8");
  const readme = await readFile(join(REPO_ROOT, "README.md"), "utf8");
  const app = await readFile(join(REPO_ROOT, "workspace", "app.js"), "utf8");

  assert.match(jobApply, /resume-extraction-request-list --status requested/);
  assert.match(jobApply, /Never scan for extraction requests during every job application/);
  assert.match(jobApply, /delete the permission-restricted candidate file/);
  assert.match(jobApply, /Stop at proposal review/);
  for (const text of [workspaceSkill, readme]) {
    assert.match(text, /queues work for the next active Job Apply agent/);
    assert.match(text, /does not start or launch an agent/);
    assert.match(text, /cannot extract facts, complete or fail a request, or author a proposal/);
  }

  const requestRoutes = [...app.matchAll(/"(\/api\/resume-extraction-requests[^"`]*)"/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(requestRoutes)], ["/api/resume-extraction-requests"]);
  assert.ok(app.includes('path += `/${encodeURIComponent(request.requestId)}/cancel`'));
  assert.ok(app.includes('path += `/${encodeURIComponent(request.requestId)}/retry`'));
  assert.doesNotMatch(app, /resume-extraction-requests[^\n]{0,100}\/(?:complete|fail|candidate)/);
});

test("resume extraction onboarding oracle is packaged in every protected OS validation job", async () => {
  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["qa:resume-extraction-onboarding"],
    "python3 qa/resume_extraction_onboarding_oracle.py --json",
  );

  const workflow = await readFile(join(REPO_ROOT, ".github", "workflows", "validate.yml"), "utf8");
  const command = "run: npm run qa:resume-extraction-onboarding";
  assert.equal(workflow.split(command).length - 1, 4);
  const jobs = [
    "validate", "windows-store-workspace", "macos-credential-helper",
    "macos-account-flow-helper",
  ];
  const starts = jobs.map((job) => workflow.indexOf(`  ${job}:`));
  for (const [index, job] of jobs.entries()) {
    const start = starts[index];
    assert.notEqual(start, -1, job);
    const next = starts[index + 1] ?? -1;
    const block = workflow.slice(start, next === -1 ? undefined : next);
    assert.ok(block.includes(command), job);
  }
  assert.match(workflow, /pull_request:\n\s+branches: \[main, staging\]/);
});

test("styles include visible focus, reduced motion, contrast mode, and responsive behavior", async () => {
  const css = await readFile(join(REPO_ROOT, "workspace", "styles.css"), "utf8");
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /--notice-bg:\s*#e7f3ec/);
  assert.match(css, /--notice-ink:\s*#204d38/);
  assert.match(css, /--notice-line:\s*#b9d8c7/);
  assert.match(css, /--notice-bg:#22372d/);
  assert.match(css, /--notice-ink:#d8eee4/);
  assert.match(css, /\.notice\s*\{[^}]*color:\s*var\(--notice-ink\)[^}]*background:\s*var\(--notice-bg\)[^}]*border:\s*1px solid var\(--notice-line\)/);
  assert.match(css, /@media \(max-width:/);
});
