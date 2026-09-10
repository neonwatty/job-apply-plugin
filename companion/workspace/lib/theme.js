(() => {
  const key = "job-apply-color-theme";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  try { preference = localStorage.getItem(key) || "system"; } catch { /* Storage is optional. */ }
  if (!["system", "light", "dark"].includes(preference)) preference = "system";
  function apply() {
    const theme = preference === "system" ? (system.matches ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
  apply();
  system.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", () => {
    const control = document.getElementById("color-theme");
    control.value = preference;
    control.addEventListener("change", () => {
      preference = control.value;
      try { localStorage.setItem(key, preference); } catch { /* Keep the current selection in memory. */ }
      apply();
    });
  });
})();
