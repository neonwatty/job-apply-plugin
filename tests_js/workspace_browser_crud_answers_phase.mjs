import {
  answerApiPath, assert,
} from "./workspace_test_support.mjs";

export async function runBrowserCrudAnswersPhase(context) {
  const { cli, page } = context;
    const cliObserved = await cli("answer-observe", [], { question: "Will you relocate for this role?", state: "missing", scope: { ats: "browser" } });
    await page.getByRole("button", { name: "Answers" }).click();
    await page.locator("#answer-view").selectOption("pending");
    await page.getByRole("heading", { name: "Will you relocate for this role?" }).waitFor();
    const observedCard = page.locator(".answer-card").filter({ hasText: "Will you relocate for this role?" });
    assert.equal(await observedCard.getAttribute("role"), null);
    assert.equal(await observedCard.locator("xpath=..").getAttribute("role"), "listitem");
    await observedCard.click();
    await page.locator("#answer-dialog[open]").waitFor();
    await page.locator("#answer-dialog").getByLabel("State").selectOption("sensitive");
    await page.locator("#answer-dialog").getByLabel("Sensitivity").selectOption("high");
    await page.locator("#answer-dialog").getByLabel("Value", { exact: true }).fill("relocation-sensitive-draft");
    await page.locator("#answer-dialog").getByLabel(/freshly consent/).check();
    await page.locator("#answer-dialog").getByRole("button", { name: "Accept", exact: true }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    const acceptedObserved = await cli("answer-get", ["--key", cliObserved.key]);
    assert.equal(acceptedObserved.reviewStatus, "accepted");
    assert.equal("value" in acceptedObserved, false);
    assert.equal((await cli("answer-reveal", ["--key", cliObserved.key])).value, "relocation-sensitive-draft");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "answer-new");

    await page.locator("#answer-view").selectOption("accepted");
    const questionless = await cli("answer-put", [], { key: "explicit-questionless", state: "missing" });
    const reservedObserved = await cli("answer-put", [], { key: "observed", question: "Reserved observed browser key?", state: "confirmed", value: "observed value" });
    const reservedTrash = await cli("answer-put", [], { key: "trash", question: "Reserved trash browser key?", state: "confirmed", value: "trash value" });
    const dotOnly = await cli("answer-put", [], { key: "..", state: "missing" });
    const slowDetail = await cli("answer-put", [], { question: "Slow answer detail?", state: "missing" });
    const fastDetail = await cli("answer-put", [], { question: "Fast answer detail?", state: "missing" });
    await page.getByRole("button", { name: "Refresh" }).click();

    const slowDetailRoute = `**${answerApiPath(slowDetail.key)}`;
    let releaseSlowDetail;
    let slowDetailSeenResolve;
    const slowDetailSeen = new Promise((resolve) => { slowDetailSeenResolve = resolve; });
    const slowDetailRelease = new Promise((resolve) => { releaseSlowDetail = resolve; });
    await page.route(slowDetailRoute, async (route) => {
      const response = await route.fetch();
      slowDetailSeenResolve();
      await slowDetailRelease;
      await route.fulfill({ response });
    });
    await page.locator(`.answer-card[data-key="${slowDetail.key}"]`).click();
    await slowDetailSeen;
    await page.locator(`.answer-card[data-key="${fastDetail.key}"]`).click();
    await page.locator("#answer-dialog[open]").waitFor();
    assert.equal(await page.locator("#answer-dialog").getByLabel("Question").inputValue(), "Fast answer detail?");
    await page.locator("#answer-dialog").getByLabel("Aliases (one per line)").fill("newest answer draft");
    const slowDetailResponse = page.waitForResponse((response) => new URL(response.url()).pathname === answerApiPath(slowDetail.key));
    releaseSlowDetail();
    await slowDetailResponse;
    assert.equal(await page.locator("#answer-dialog").getByLabel("Question").inputValue(), "Fast answer detail?");
    assert.equal(await page.locator("#answer-dialog").getByLabel("Aliases (one per line)").inputValue(), "newest answer draft");
    await page.locator("#answer-dialog").getByRole("button", { name: "Close answer details" }).click();
    await page.unroute(slowDetailRoute);

    await page.locator(`.answer-card[data-key="${dotOnly.key}"]`).click();
    const dotOnlyDialog = page.locator("#answer-dialog");
    await dotOnlyDialog.waitFor({ state: "visible" });
    await dotOnlyDialog.getByLabel("Aliases (one per line)").fill("dot-only browser alias");
    const dotOnlyPath = answerApiPath(dotOnly.key);
    const dotOnlyPatch = page.waitForResponse((response) => {
      const request = response.request();
      return new URL(response.url()).pathname === dotOnlyPath && request.method() === "PATCH";
    });
    await dotOnlyDialog.getByRole("button", { name: "Save answer" }).click();
    const dotOnlyResponse = await dotOnlyPatch;
    assert.equal(dotOnlyResponse.status(), 200);
    await dotOnlyDialog.waitFor({ state: "hidden" });
    assert.deepEqual((await cli("answer-get", ["--key", dotOnly.key])).aliases, ["dot only browser alias"]);
    await page.locator(`.answer-card[data-key="${dotOnly.key}"]`).click();
    page.once("dialog", (prompt) => prompt.accept());
    await page.locator("#answer-dialog").getByRole("button", { name: "Move to trash" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    await page.locator("#answer-view").selectOption("trash");
    await page.locator(`.answer-card[data-key="${dotOnly.key}"]`).click();
    await page.locator("#answer-dialog").getByRole("button", { name: "Restore" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    await page.locator("#answer-view").selectOption("accepted");

    await page.locator(`.answer-card[data-key="${questionless.key}"]`).click();
    const questionlessDialog = page.locator("#answer-dialog");
    await questionlessDialog.waitFor({ state: "visible" });
    assert.equal(await questionlessDialog.getByLabel("Question").getAttribute("required"), null);
    await questionlessDialog.getByLabel("Aliases (one per line)").fill("questionless browser alias");
    const questionlessPath = answerApiPath(questionless.key);
    const questionlessPatch = page.waitForResponse((response) => {
      const request = response.request();
      return new URL(response.url()).pathname === questionlessPath && request.method() === "PATCH";
    });
    await questionlessDialog.getByRole("button", { name: "Save answer" }).click();
    const questionlessResponse = await questionlessPatch;
    assert.equal(questionlessResponse.status(), 200);
    await questionlessDialog.waitFor({ state: "hidden" });
    assert.deepEqual((await cli("answer-get", ["--key", questionless.key])).aliases, ["questionless browser alias"]);
    await page.locator(`.answer-card[data-key="${questionless.key}"]`).click();
    await page.locator("#answer-dialog").getByRole("button", { name: "Merge duplicate…" }).click();
    await page.locator("#answer-merge-dialog").waitFor({ state: "visible" });
    const questionlessMergeCopy = await page.locator("#answer-merge-source").innerText();
    assert.equal(questionlessMergeCopy.includes(`Question not recorded (explicit key: ${questionless.key})`), true);
    assert.equal(questionlessMergeCopy.includes("· accepted · revision 2"), true);
    assert.equal(questionlessMergeCopy.includes("It has no retained value to discard."), true);
    await page.locator("#answer-merge-dialog").getByRole("button", { name: "Cancel" }).click();
    await page.locator("#answer-dialog").getByRole("button", { name: "Close answer details" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    await page.locator(`.answer-card[data-key="${reservedObserved.key}"]`).click();
    const reservedObservedDialog = page.locator("#answer-dialog");
    await reservedObservedDialog.waitFor({ state: "visible" });
    assert.equal(await reservedObservedDialog.getByLabel("Question").inputValue(), "Reserved observed browser key?");
    const reservedObservedAliases = reservedObservedDialog.getByLabel("Aliases (one per line)");
    await reservedObservedAliases.fill("reserved observed alias");
    assert.equal(await reservedObservedAliases.inputValue(), "reserved observed alias");
    const reservedObservedPath = answerApiPath(reservedObserved.key);
    const reservedObservedPatch = page.waitForResponse((response) => {
      const request = response.request();
      return new URL(response.url()).pathname === reservedObservedPath && request.method() === "PATCH";
    });
    await reservedObservedDialog.getByRole("button", { name: "Save answer" }).click();
    const reservedObservedResponse = await reservedObservedPatch;
    assert.equal(reservedObservedResponse.status(), 200);
    assert.deepEqual(reservedObservedResponse.request().postDataJSON().patch, { aliases: ["reserved observed alias"] });
    await reservedObservedDialog.waitFor({ state: "hidden" });
    assert.deepEqual((await cli("answer-get", ["--key", reservedObserved.key])).aliases, ["reserved observed alias"]);
    await page.locator(".answer-card").filter({ hasText: "Reserved trash browser key?" }).click();
    page.once("dialog", (prompt) => prompt.accept());
    await page.locator("#answer-dialog").getByRole("button", { name: "Move to trash" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    await page.locator("#answer-view").selectOption("trash");
    await page.locator(".answer-card").filter({ hasText: "Reserved trash browser key?" }).click();
    await page.locator("#answer-dialog").getByRole("button", { name: "Restore" }).click();
    await page.locator("#answer-dialog").waitFor({ state: "hidden" });
    assert.equal((await cli("answer-get", ["--key", reservedTrash.key])).deletedAt, null);
    await page.locator("#answer-view").selectOption("accepted");
    await page.getByRole("button", { name: "New answer" }).click();
    const answerDialog = page.locator("#answer-dialog");
    await answerDialog.getByLabel("Question").fill("Browser reusable answer?");
    await answerDialog.getByLabel("Value", { exact: true }).fill("Browser reusable value");
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await answerDialog.waitFor({ state: "hidden" });
    let browserAnswer = await cli("answer-find", ["--question", "Browser reusable answer?", "--scope", "{}"]);
    assert.equal(browserAnswer.value, "Browser reusable value");

    await page.getByRole("button", { name: "New answer" }).click();
    await answerDialog.getByLabel("Question").fill("Browser private answer?");
    await answerDialog.getByLabel("State").selectOption("sensitive");
    await answerDialog.getByLabel("Sensitivity").selectOption("high");
    await answerDialog.getByLabel("Value", { exact: true }).fill("browser-sensitive-secret");
    await answerDialog.getByLabel(/freshly consent/).check();
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await answerDialog.waitFor({ state: "hidden" });
    const cliLibrary = await cli("answer-list");
    const sensitiveAnswer = await cli("answer-find", ["--question", "Browser private answer?", "--scope", "{}"]);
    assert.equal(JSON.stringify(cliLibrary).includes("browser-sensitive-secret"), false);
    assert.equal("value" in sensitiveAnswer, false);
    const sensitiveCard = page.locator(".answer-card").filter({ hasText: "Browser private answer?" });
    assert.equal((await sensitiveCard.innerText()).includes("browser-sensitive-secret"), false);
    await sensitiveCard.click();
    await page.locator("#answer-dialog[open]").waitFor();
    assert.equal(await answerDialog.getByLabel("Value", { exact: true }).inputValue(), "");
    await answerDialog.getByRole("button", { name: "Reveal sensitive value" }).click();
    await page.waitForFunction(() => document.querySelector("#answer-form [name=value]")?.value === "browser-sensitive-secret");
    assert.equal(await answerDialog.getByLabel("Value", { exact: true }).inputValue(), "browser-sensitive-secret");
    await answerDialog.getByRole("button", { name: "Close answer details" }).click();
    await page.waitForFunction((key) => document.activeElement?.dataset?.key === key, sensitiveAnswer.key);

    const duplicate = await cli("answer-put", [], { question: "Duplicate browser reusable answer?", state: "confirmed", value: "discarded-browser-duplicate" });
    await page.getByRole("button", { name: "Refresh" }).click();
    const duplicateCard = page.locator(".answer-card").filter({ hasText: "Duplicate browser reusable answer?" });
    const duplicateDetailPath = answerApiPath(duplicate.key);
    let duplicateDetailResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === duplicateDetailPath
      && response.request().method() === "GET"
    ));
    await duplicateCard.click();
    assert.equal((await duplicateDetailResponse).status(), 200);
    await answerDialog.waitFor({ state: "visible" });
    assert.equal(await answerDialog.getByLabel("Question").inputValue(), "Duplicate browser reusable answer?");
    await answerDialog.getByLabel("Aliases (one per line)").fill("unsaved source merge draft");
    await answerDialog.getByRole("button", { name: "Merge duplicate…" }).click();
    await answerDialog.getByText("Save this draft or close the answer details to discard it before merging.").waitFor();
    assert.equal(await page.locator("#answer-merge-dialog").isVisible(), false);
    assert.equal(await answerDialog.getByLabel("Aliases (one per line)").inputValue(), "unsaved source merge draft");
    await answerDialog.getByRole("button", { name: "Close answer details" }).click();
    await answerDialog.waitFor({ state: "hidden" });
    duplicateDetailResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === duplicateDetailPath
      && response.request().method() === "GET"
    ));
    await duplicateCard.click();
    assert.equal((await duplicateDetailResponse).status(), 200);
    await answerDialog.getByRole("button", { name: "Merge duplicate…" }).click();
    const mergeDialog = page.locator("#answer-merge-dialog");
    await mergeDialog.waitFor({ state: "visible" });
    assert.equal((await mergeDialog.innerText()).includes("Browser reusable value"), false);
    assert.equal((await mergeDialog.innerText()).includes("discarded-browser-duplicate"), false);
    await mergeDialog.getByLabel("Accepted winner").selectOption(browserAnswer.key);
    await mergeDialog.getByRole("button", { name: "Merge into selected winner" }).click();
    await mergeDialog.waitFor({ state: "hidden" });
    await answerDialog.waitFor({ state: "hidden" });
    const redirectedDuplicate = await cli("answer-get", ["--key", duplicate.key]);
    assert.equal(redirectedDuplicate.key, browserAnswer.key);
    assert.equal(redirectedDuplicate.redirectedFrom, duplicate.key);
    assert.equal((await cli("answer-reveal", ["--key", duplicate.key])).value, "Browser reusable value");
    browserAnswer = await cli("answer-get", ["--key", browserAnswer.key]);
    const afterMerge = await cli("answer-list");
    assert.equal(JSON.stringify(afterMerge).includes("discarded-browser-duplicate"), false);

    let releaseOlderAnswerQuery;
    let olderAnswerQuerySeenResolve;
    const olderAnswerQuerySeen = new Promise((resolve) => { olderAnswerQuerySeenResolve = resolve; });
    const olderAnswerQueryRelease = new Promise((resolve) => { releaseOlderAnswerQuery = resolve; });
    await page.route("**/api/answers/query", async (route) => {
      const query = route.request().postDataJSON()?.query;
      if (query === "Browser reusable") {
        const response = await route.fetch();
        olderAnswerQuerySeenResolve();
        await olderAnswerQueryRelease;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await page.locator("#answer-search").fill("Browser reusable");
    await olderAnswerQuerySeen;
    await page.locator("#answer-search").fill("No canonical answer matches this");
    await page.waitForFunction(() => document.querySelector("#answers-status")?.textContent?.startsWith("0 canonical"));
    const olderAnswerQueryResponse = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/answers/query"
      && response.request().postDataJSON()?.query === "Browser reusable"
    ));
    releaseOlderAnswerQuery();
    await olderAnswerQueryResponse;
    assert.equal(await page.locator(".answer-card").count(), 0);
    await page.unroute("**/api/answers/query");
    await page.locator("#answer-search").fill("");
    await page.getByRole("heading", { name: "Browser reusable answer?" }).waitFor();
    await page.locator("#answer-state-filter").selectOption("sensitive");
    await page.waitForFunction(() => ![...document.querySelectorAll(".answer-card")].some((card) => card.textContent?.includes("Browser reusable answer?")));
    assert.equal(await page.locator(".answer-card").filter({ hasText: "Browser private answer?" }).count(), 1);
    assert.equal(await page.locator(".answer-card").filter({ hasText: "Browser reusable answer?" }).count(), 0);
    await page.locator("#answer-state-filter").selectOption("");
    await page.getByRole("heading", { name: "Browser reusable answer?" }).waitFor();

    const reusableCard = page.locator(".answer-card").filter({ hasText: "Browser reusable answer?" });
    await reusableCard.click();
    await answerDialog.getByLabel("Aliases (one per line)").fill("Browser alias draft");
    browserAnswer = await cli("answer-update", ["--key", browserAnswer.key, "--expected-revision", String(browserAnswer.revision)], { source: "agent" });
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await page.locator("#answer-conflict").waitFor();
    assert.equal(await answerDialog.getByLabel("Aliases (one per line)").inputValue(), "Browser alias draft");
    await page.locator("#answer-conflict").getByRole("button", { name: "Refresh canonical revision" }).click();
    assert.equal(await answerDialog.getByLabel("Aliases (one per line)").inputValue(), "Browser alias draft");
    await answerDialog.getByRole("button", { name: "Save answer" }).click();
    await answerDialog.waitFor({ state: "hidden" });
    browserAnswer = await cli("answer-find", ["--question", "Browser alias draft", "--scope", "{}"]);
    assert.equal(browserAnswer.source, "agent");

    await cli("history-append", [], { applicationId: "browser-answer-history", event: "reviewed", answerKeys: [browserAnswer.key] });
    await page.locator(".answer-card").filter({ hasText: "Browser reusable answer?" }).click();
    page.once("dialog", (prompt) => prompt.accept());
    await answerDialog.getByRole("button", { name: "Move to trash" }).click();
    await answerDialog.getByText("This answer is a canonical redirect target and cannot be moved or deleted.").waitFor();
    const activeRedirectTarget = await cli("answer-get", ["--key", browserAnswer.key, "--include-trashed"]);
    assert.equal(activeRedirectTarget.key, browserAnswer.key);
    assert.equal(activeRedirectTarget.deletedAt, null);
    await answerDialog.getByRole("button", { name: "Close answer details" }).click();
}
