export function installReadiness({ api, dom: { $ }, coordinators }) {
  const dialog = $("#readiness-dialog");
  const content = $("#profile-readiness");
  let sequence = 0;
  async function refreshReadiness() {
    const request = ++sequence;
    try {
      const result = await api("/api/profile-preparedness");
      if (request === sequence) coordinators.renderPreparedness(result);
    } catch {
      if (request === sequence) $("#profile-readiness-sections").textContent = "Readiness is unavailable. Refresh Overview or reopen this panel to try again.";
    }
  }
  function openReadiness() {
    if (dialog.open) return;
    $("#readiness-drawer-content").append(content);
    dialog.showModal();
    refreshReadiness();
  }
  $("#view-readiness").addEventListener("click", openReadiness);
  $("#close-readiness").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => $("#readiness-home").append(content));
  content.addEventListener("click", event => {
    if (dialog.open && event.target.closest("button")) dialog.close();
  }, true);
  Object.assign(coordinators, { openReadiness, refreshReadiness });
}
