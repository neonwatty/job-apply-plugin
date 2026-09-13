// Response headers and dialog closure precede activity rendering. Native dialog
// focus restoration can still point to the old action until that render finishes.
export async function waitForLinkedAnswerReturn(page) {
  await page.waitForFunction(() => {
    const job = document.querySelector("#job-dialog[open]");
    const actions = [...(job?.querySelectorAll("button[data-pending-reference]") || [])];
    const edit = actions.find((button) => button.textContent.trim() === "Open in Answers");
    const recheck = actions.find((button) => button.textContent.trim() === "Recheck this revision");
    return Boolean(edit && recheck && !recheck.disabled
      && edit.dataset.pendingReference === recheck.dataset.pendingReference
      && document.activeElement === edit);
  });
}
