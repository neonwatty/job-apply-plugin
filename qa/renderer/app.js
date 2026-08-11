const application = document.querySelector("#application");
const progress = document.querySelector("#progress");
const enteredValues = new Map();
const recordedEvents = new Set();
let fixtureData;
let eventQueue = Promise.resolve();

function recordEvent(type, controlId, stepId) {
  const key = `${type}:${controlId}:${stepId}`;
  if (recordedEvents.has(key)) return eventQueue;
  recordedEvents.add(key);
  eventQueue = eventQueue
    .then(() =>
      fetch("/__qa/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, controlId, stepId }),
      }),
    )
    .then((response) => {
      if (!response.ok) throw new Error("Unable to record semantic event");
    });
  return eventQueue;
}

function renderControl(control, stepId) {
  const group = document.createElement("div");
  group.className = "control";
  const label = document.createElement("label");
  label.htmlFor = control.id;
  label.textContent = control.label;
  const input = document.createElement("input");
  input.id = control.id;
  input.name = control.id;
  input.required = control.required;
  const error = document.createElement("p");
  error.className = "error";
  error.id = `${control.id}-error`;
  input.setAttribute("aria-describedby", error.id);

  if (control.role === "file") {
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    const filename = document.createElement("p");
    filename.className = "filename";
    input.addEventListener("change", () => {
      const file = input.files[0];
      enteredValues.set(control.id, file ? file.name : "");
      filename.textContent = file ? file.name : "";
      error.textContent = "";
      if (file) recordEvent("uploaded", control.id, stepId);
    });
    group.append(label, input, filename, error);
  } else {
    input.type =
      control.kind === "contact.email"
        ? "email"
        : control.kind === "contact.phone"
          ? "tel"
          : "text";
    input.autocomplete = "off";
    input.addEventListener("input", () => {
      enteredValues.set(control.id, input.value);
      error.textContent = "";
      if (input.value.trim()) recordEvent("filled", control.id, stepId);
    });
    group.append(label, input, error);
  }
  return group;
}

function validateStep(step) {
  let valid = true;
  for (const control of step.controls) {
    const input = document.getElementById(control.id);
    const missing =
      control.required &&
      (control.role === "file"
        ? input.files.length === 0
        : !input.value.trim());
    const error = document.getElementById(`${control.id}-error`);
    if (missing) {
      valid = false;
      error.textContent = `${control.label} is required`;
      recordEvent("validation", control.id, step.id);
    } else {
      error.textContent = "";
    }
  }
  return valid;
}

function reviewList() {
  const list = document.createElement("dl");
  list.className = "review-list";
  for (const step of fixtureData.steps) {
    for (const control of step.controls) {
      const term = document.createElement("dt");
      term.textContent = control.label;
      const description = document.createElement("dd");
      description.textContent = enteredValues.get(control.id) || "Not provided";
      list.append(term, description);
    }
  }
  return list;
}

async function activateFinalAction(stepId) {
  let response;
  try {
    response = await fetch("/__qa/final-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepId }),
    });
  } finally {
    const notice = document.querySelector("#tripwire-notice");
    notice.textContent = "Final action blocked by QA tripwire";
    notice.focus();
  }
  if (response.status !== 409)
    throw new Error("QA tripwire did not block final action");
}

function renderStep(fixture, stepId) {
  const step = fixture.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("Fixture step is unavailable");
  const index = fixture.steps.indexOf(step);
  progress.textContent = `Step ${index + 1} of ${fixture.steps.length}`;
  application.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = step.title;
  application.append(heading);

  if (step.kind === "review") {
    application.append(reviewList());
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = step.finalAction.label;
    button.disabled = !step.finalAction.enabled;
    button.addEventListener("click", () => activateFinalAction(step.id));
    const notice = document.createElement("p");
    notice.id = "tripwire-notice";
    notice.className = "tripwire";
    notice.tabIndex = -1;
    application.append(button, notice);
    recordEvent("reviewed", "", step.id);
    return;
  }

  const form = document.createElement("form");
  form.noValidate = true;
  for (const control of step.controls)
    form.append(renderControl(control, step.id));
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Continue";
  form.append(button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!validateStep(step)) return;
    await eventQueue;
    await recordEvent("advanced", "", step.id);
    renderStep(fixture, step.next);
  });
  application.append(form);
}

fetch("/__qa/fixture")
  .then((response) => {
    if (!response.ok) throw new Error("Fixture unavailable");
    return response.json();
  })
  .then((fixture) => {
    fixtureData = fixture;
    renderStep(fixture, fixture.steps[0].id);
  })
  .catch(() => {
    application.textContent = "Application replay is unavailable.";
  });

export {
  activateFinalAction,
  recordEvent,
  renderControl,
  renderStep,
  validateStep,
};
