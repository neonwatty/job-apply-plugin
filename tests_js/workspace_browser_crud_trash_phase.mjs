import {
  assert, join, writeFile,
} from "./workspace_test_support.mjs";

export async function runBrowserCrudTrashShutdownPhase(context) {
  const { cli, cliUpdated, newest, page, temporary, uiJob } = context;
  let { browser, server } = context;
    // The packaged smoke selects this test by name, so this is the source and
    // packaged proof for the top-level unified Trash lifecycle.
    const trashJob = await cli("job-create", [], { id: "trash-ui-job", url: "https://private.example/jobs/trash-ui", role: "Trash UI job" });
    await cli("job-trash", ["--id", trashJob.id, "--expected-revision", String(trashJob.revision)]);
    const trashResumePath = join(temporary, "private-trash-resume.txt");
    await writeFile(trashResumePath, "private trash resume bytes");
    const trashResume = await cli("resume-create", [], { id: "trash-ui-resume", label: "Trash UI resume", path: trashResumePath });
    await cli("resume-trash", ["--id", trashResume.id, "--expected-revision", String(trashResume.revision)]);
    const trashAnswer = await cli("answer-put", [], { question: "Trash UI answer?", state: "confirmed", value: "private-trash-answer" });
    await cli("answer-trash", ["--key", trashAnswer.key, "--expected-revision", String(trashAnswer.revision)]);
    const protectedAnswer = await cli("answer-put", [], { question: "Protected Trash UI answer?", state: "confirmed", value: "protected-private-answer" });
    await cli("history-append", [], { applicationId: "trash-ui-history", event: "reviewed", answerKeys: [protectedAnswer.key] });
    await cli("answer-trash", ["--key", protectedAnswer.key, "--expected-revision", String(protectedAnswer.revision)]);

    await page.locator("#nav-trash").click();
    await page.locator("#trash-refresh").click();
    await page.getByText("1 jobs · 1 resumes · 2 answers").waitFor();
    const trashWorkspaceText = await page.locator("#trash-workspace").innerText();
    for (const privateValue of ["private.example", "private-trash-answer", "protected-private-answer", "private-trash-resume.txt"]) {
      assert.equal(trashWorkspaceText.includes(privateValue), false);
    }
    const typeFilter = page.locator("#trash-type-filter");
    await typeFilter.selectOption("job");
    assert.equal(await page.locator(".trash-card").count(), 1);
    assert.match(await page.locator(".trash-card").innerText(), /Trash UI job/);

    // Restore persists canonically, then a stale destructive request is never retried.
    await page.locator(".trash-card").getByRole("button", { name: "Restore" }).click();
    let currentTrashJob = await cli("job-get", ["--id", trashJob.id]);
    assert.equal(currentTrashJob.deletedAt, null);
    currentTrashJob = await cli("job-trash", ["--id", currentTrashJob.id, "--expected-revision", String(currentTrashJob.revision)]);
    await page.locator("#trash-refresh").click();
    const staleJobCard = page.locator(".trash-card").filter({ hasText: "Trash UI job" });
    const refreshedJob = await cli("job-restore", ["--id", currentTrashJob.id, "--expected-revision", String(currentTrashJob.revision)]);
    currentTrashJob = await cli("job-trash", ["--id", refreshedJob.id, "--expected-revision", String(refreshedJob.revision)]);
    await staleJobCard.getByRole("button", { name: "Delete permanently…" }).click();
    let trashDeleteDialog = page.locator("#trash-delete-dialog");
    await trashDeleteDialog.getByLabel(/Type DELETE JOB/).fill("DELETE JOB");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await page.locator("#trash-delete-conflict").waitFor();
    assert.match(await page.locator("#trash-delete-conflict").innerText(), /Nothing was deleted.*not retried/s);
    assert.ok(await cli("job-get", ["--id", currentTrashJob.id, "--include-trashed"]));
    const refreshedTrashResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/trash" && response.ok());
    await page.locator("#trash-conflict-refresh").click();
    await refreshedTrashResponse;
    await trashDeleteDialog.waitFor({ state: "hidden" });

    // Exact typed deletion removes only the refreshed selected job.
    await page.locator(".trash-card").filter({ hasText: "Trash UI job" }).getByRole("button", { name: "Delete permanently…" }).click();
    await trashDeleteDialog.getByLabel(/Type DELETE JOB/).fill("DELETE JOB");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await trashDeleteDialog.waitFor({ state: "hidden" });
    assert.equal(await cli("job-get", ["--id", currentTrashJob.id, "--include-trashed"]), null);

    // Resume restore persists; its confirmation discloses managed-file destruction.
    await typeFilter.selectOption("resume");
    await page.locator(".trash-card").filter({ hasText: "Trash UI resume" }).getByRole("button", { name: "Restore" }).click();
    let currentTrashResume = await cli("resume-get", ["--id", trashResume.id]);
    assert.equal(currentTrashResume.deletedAt, null);
    currentTrashResume = await cli("resume-trash", ["--id", currentTrashResume.id, "--expected-revision", String(currentTrashResume.revision)]);
    await page.locator("#trash-refresh").click();
    await page.locator(".trash-card").filter({ hasText: "Trash UI resume" }).getByRole("button", { name: "Delete permanently…" }).click();
    assert.match(await page.locator("#trash-delete-impact").innerText(), /managed resume file.*unrelated jobs.*history, sessions, or audit evidence/);
    await trashDeleteDialog.getByLabel(/Type DELETE RESUME/).fill("DELETE RESUME");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await trashDeleteDialog.waitFor({ state: "hidden" });
    assert.equal(await cli("resume-get", ["--id", currentTrashResume.id, "--include-trashed"]), null);

    // Answer restore persists, while protected history produces actionable blocker copy.
    await typeFilter.selectOption("answer");
    const trashAnswerCard = page.locator(".trash-card").filter({ has: page.getByRole("heading", { name: "Trash UI answer?", exact: true }) });
    await trashAnswerCard.getByRole("button", { name: "Restore" }).click();
    let currentTrashAnswer = await cli("answer-get", ["--key", trashAnswer.key]);
    assert.equal(currentTrashAnswer.deletedAt, null);
    currentTrashAnswer = await cli("answer-trash", ["--key", currentTrashAnswer.key, "--expected-revision", String(currentTrashAnswer.revision)]);
    await page.locator("#trash-refresh").click();
    await page.locator(".trash-card").filter({ hasText: "Protected Trash UI answer?" }).getByRole("button", { name: "Delete permanently…" }).click();
    await trashDeleteDialog.getByLabel(/Type DELETE ANSWER/).fill("DELETE ANSWER");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await page.locator("#trash-delete-error").getByText(/protected application history.*1 protected reference/i).waitFor();
    assert.ok(await cli("answer-get", ["--key", protectedAnswer.key, "--include-trashed"]));
    await trashDeleteDialog.getByRole("button", { name: "Cancel" }).click();
    await trashAnswerCard.getByRole("button", { name: "Delete permanently…" }).click();
    await trashDeleteDialog.getByLabel(/Type DELETE ANSWER/).fill("DELETE ANSWER");
    await trashDeleteDialog.getByRole("button", { name: "Delete permanently" }).click();
    await trashDeleteDialog.waitFor({ state: "hidden" });
    assert.equal(await cli("answer-get", ["--key", currentTrashAnswer.key, "--include-trashed"]), null);

    await browser.close(); browser = null;
    context.browser = browser;
    server.kill("SIGINT");
    const exitCode = await new Promise((resolve) => server.once("exit", resolve));
    assert.equal(exitCode, 0);
    server = null;
    context.server = server;
    assert.equal((await cli("job-list", ["--status", "applied"])).some((job) => job.id === uiJob.id), true);
    assert.equal(cliUpdated.role, "CLI canonical edit");
    assert.equal(newest.notes, "Newest canonical note");
}
