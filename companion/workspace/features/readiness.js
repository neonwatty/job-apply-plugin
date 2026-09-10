export function installReadiness({ api, dom: { $ }, coordinators }) {
  const dialog = $("#readiness-dialog");
  const content = $("#profile-readiness");
  let sequence = 0;
  let closing = false;
  let backdropPress = false;
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
  async function closeReadiness() {
    if (!dialog.open || closing) return;
    closing = true;
    dialog.classList.add("closing");
    let animation;
    try {
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const style = getComputedStyle(dialog);
        animation = dialog.animate([
          { transform: style.transform, opacity: style.opacity },
          { transform: "translateX(100%)", opacity: 0 },
        ], { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
        await animation.finished;
      }
    } catch { /* A cancelled animation must still release the modal. */ }
    finally {
      dialog.close();
      animation?.cancel();
      dialog.classList.remove("closing");
      closing = false;
    }
  }
  function outside(event) {
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  }
  dialog.addEventListener("pointerdown", event => { backdropPress = event.target === dialog && outside(event); });
  dialog.addEventListener("click", event => {
    if (backdropPress && event.target === dialog && outside(event)) closeReadiness();
    backdropPress = false;
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeReadiness(); });
  $("#view-readiness").addEventListener("click", openReadiness);
  $("#close-readiness").addEventListener("click", closeReadiness);
  dialog.addEventListener("close", () => { if (!dialog.open) $("#readiness-home").append(content); });
  content.addEventListener("click", event => {
    if (dialog.open && event.target.closest("button")) dialog.close();
  }, true);
  Object.assign(coordinators, { openReadiness, refreshReadiness });
}
