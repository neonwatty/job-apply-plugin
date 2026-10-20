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
    const control = document.getElementById("color-theme");
    if (control) {
      const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
      control.setAttribute("aria-label", label); control.title = label;
    }
  }
  apply();
  system.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", () => {
    const control = document.getElementById("color-theme");
    apply();
    control.addEventListener("click", () => {
      document.documentElement.classList.add("theme-transition");
      preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(key, preference); } catch { /* Keep the current selection in memory. */ }
      apply();
    });
  });
})();
