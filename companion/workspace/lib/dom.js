export function createDom(state, token) {
  const $ = (selector) => document.querySelector(selector);
  const form = $("#job-form");
  const dialog = $("#job-dialog");
  const statusLabel = (value) => String(value || "saved").replaceAll("_", " ");
  const escapeText = (value) => String(value ?? "");

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.add("hidden"), 3500);
  }

  function setConnection(online, message = online ? "Canonical store connected" : "Connection lost") {
    if (online && state.overview.unavailable) return;
    $("#connection-dot").classList.toggle("online", online);
    $("#connection-label").textContent = message;
  }

  return { $, form, dialog, statusLabel, escapeText, toast, setConnection, token };
}
