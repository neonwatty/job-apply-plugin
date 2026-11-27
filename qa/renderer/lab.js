const sample = {
  "contact.first_name": "Avery",
  "contact.last_name": "Replay",
  "contact.email": "avery.replay@example.com",
  "contact.phone_country": "United States +1",
  "contact.phone": "602-555-0142",
  "contact.location_city": "Phoenix, Arizona, United States",
  "profile.linkedin": "https://example.com/synthetic-linkedin",
  "authorization.sponsorship_select": "No",
  "employment.prior_affiliate": "No",
  "source.discovery": "Other",
};

export function addSampleAnswers(form, resumeName) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Load fictional answers and résumé";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "";
    try {
      const response = await fetch("/__qa/lab-resume", { redirect: "error" });
      if (!response.ok) throw new Error("Sample résumé is unavailable");
      const file = new File([await response.blob()], resumeName, { type: "application/pdf" });
      for (const [id, value] of Object.entries(sample)) {
        const control = form.elements.namedItem(id);
        control.value = value;
        control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
      }
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const upload = form.elements.namedItem("resume.file");
      upload.files = transfer.files;
      upload.dispatchEvent(new Event("change", { bubbles: true }));
      status.textContent = "Fictional answers and résumé loaded.";
    } catch {
      status.textContent = "Unable to load the fictional application. Try again.";
    } finally {
      button.disabled = false;
    }
  });
  form.append(button, status);
}
