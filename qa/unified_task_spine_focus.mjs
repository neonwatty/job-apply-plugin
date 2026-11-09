// A response arriving does not mean its activity DOM has been rendered. The
// closing dialog can focus the old opener before that node is replaced.
export async function waitForSavedAnswerFocus(page) {
  await page.waitForFunction(() => {
    const controls = [...document.querySelectorAll("#job-dialog #activity-pending button")];
    const visible = (button) => button.getClientRects().length > 0;
    const openers = controls.filter((button) => visible(button)
      && button.textContent.trim() === "Open in Answers");
    const rechecks = controls.filter((button) => visible(button)
      && button.textContent.trim() === "Recheck this revision");
    return openers.length === 1 && rechecks.length === 1
      && openers[0].hasAttribute("data-pending-reference")
      && openers[0].dataset.pendingReference === rechecks[0].dataset.pendingReference
      && document.activeElement === openers[0];
  });
}
