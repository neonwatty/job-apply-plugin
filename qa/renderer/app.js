const application = document.querySelector("#application");
const progress = document.querySelector("#progress");
const enteredValues = new Map();
const recordedEvents = new Set();
let fixtureData;
let expectedResumeFilename;
const uploadFilenameMatches = new Map();
let eventQueue = Promise.resolve();
let currentStepId;
let controlFailurePending = false;

async function recordEvent(type, controlId, stepId) {
  const expectedFilenameMatched =
    type === "uploaded" ? uploadFilenameMatches.get(controlId) === true : undefined;
  const key = `${type}:${controlId}:${stepId}:${expectedFilenameMatched ?? ""}`;
  if (recordedEvents.has(key)) return;
  eventQueue = eventQueue
    .catch(() => undefined)
    .then(() =>
      recordedEvents.has(key)
        ? undefined
        : fetch("/__qa/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type,
              controlId,
              stepId,
              ...(type === "uploaded" ? { expectedFilenameMatched } : {}),
            }),
          }),
    )
    .then((response) => {
      if (response === undefined) return;
      if (!response.ok) throw new Error("Unable to record semantic event");
      recordedEvents.add(key);
    });
  return eventQueue;
}

function showInfrastructureError() {
  const notice = document.querySelector(".infrastructure-error");
  if (notice)
    notice.textContent = "Unable to record QA event. Retry this step.";
}

function recordControlEvent(type, controlId, stepId) {
  recordEvent(type, controlId, stepId).catch(() => {
    controlFailurePending = true;
    showInfrastructureError();
  });
}

function clearControlError(input, error) {
  input.removeAttribute("aria-invalid");
  error.textContent = "";
}

function controlHasValue(control) {
  if (control.role === "file")
    return document.getElementById(control.id).files.length > 0;
  if (control.role === "checkbox")
    return document.getElementById(control.id).checked;
  if (control.role === "radiogroup")
    return Boolean(
      document.querySelector(`input[name="${control.id}"]:checked`),
    );
  return Boolean(document.getElementById(control.id).value.trim());
}

function renderControl(control) {
  const stepId = currentStepId;
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
  error.setAttribute("role", "alert");
  input.setAttribute("aria-describedby", error.id);

  if (control.role === "combobox") {
    const select = document.createElement("select");
    select.id = control.id;
    select.name = control.id;
    select.required = control.required;
    select.setAttribute("aria-describedby", error.id);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select an option";
    select.append(placeholder);
    for (const choice of control.choices) {
      const option = document.createElement("option");
      option.value = choice;
      option.textContent = choice;
      select.append(option);
    }
    select.addEventListener("change", () => {
      enteredValues.set(control.id, select.value);
      if (select.value) {
        clearControlError(select, error);
        recordControlEvent("filled", control.id, stepId);
      }
    });
    group.append(label, select, error);
  } else if (control.role === "radiogroup") {
    const fieldset = document.createElement("fieldset");
    fieldset.id = control.id;
    fieldset.setAttribute("aria-describedby", error.id);
    const legend = document.createElement("legend");
    legend.textContent = control.label;
    fieldset.append(legend);
    for (const choice of control.choices) {
      const choiceLabel = document.createElement("label");
      const choiceInput = document.createElement("input");
      choiceInput.type = "radio";
      choiceInput.name = control.id;
      choiceInput.value = choice;
      choiceInput.required = control.required;
      choiceInput.addEventListener("change", () => {
        enteredValues.set(control.id, choice);
        clearControlError(fieldset, error);
        recordControlEvent("filled", control.id, stepId);
      });
      choiceLabel.append(choiceInput, document.createTextNode(choice));
      fieldset.append(choiceLabel);
    }
    group.append(fieldset, error);
  } else if (control.role === "file") {
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    const filename = document.createElement("p");
    filename.className = "filename";
    input.addEventListener("change", () => {
      const file = input.files[0];
      enteredValues.set(control.id, file ? file.name : "");
      uploadFilenameMatches.set(
        control.id,
        Boolean(file && file.name === expectedResumeFilename),
      );
      filename.textContent = file ? file.name : "";
      if (file) {
        clearControlError(input, error);
        recordControlEvent("uploaded", control.id, stepId);
      }
    });
    group.append(label, input, filename, error);
  } else if (control.role === "checkbox") {
    input.type = "checkbox";
    input.addEventListener("change", () => {
      enteredValues.set(
        control.id,
        input.checked ? "Selected" : "Not selected",
      );
      clearControlError(input, error);
      recordControlEvent("filled", control.id, stepId);
    });
    label.prepend(input);
    group.append(label, error);
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
      if (input.value.trim()) {
        clearControlError(input, error);
        recordControlEvent("filled", control.id, stepId);
      }
    });
    group.append(label, input, error);
  }
  return group;
}

function validateStep(step) {
  let valid = true;
  let firstInvalid;
  for (const control of step.controls) {
    const input = document.getElementById(control.id);
    const missing = control.required && !controlHasValue(control);
    const error = document.getElementById(`${control.id}-error`);
    if (missing) {
      valid = false;
      firstInvalid ??=
        control.role === "radiogroup"
          ? document.querySelector(`input[name="${control.id}"]`)
          : input;
      input.setAttribute("aria-invalid", "true");
      error.textContent = `${control.label} is required`;
      recordControlEvent("validation", control.id, step.id);
    } else {
      clearControlError(input, error);
    }
  }
  firstInvalid?.focus();
  return valid;
}

async function ensureControlEvents(step) {
  for (const control of step.controls) {
    const input = document.getElementById(control.id);
    if (control.role === "file" && input.files.length > 0) {
      await recordEvent("uploaded", control.id, step.id);
    } else if (control.role !== "file" && controlHasValue(control)) {
      await recordEvent("filled", control.id, step.id);
    }
  }
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
  const notice = document.querySelector("#tripwire-notice");
  try {
    const response = await fetch("/__qa/final-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepId }),
    });
    if (response.status !== 409)
      throw new Error("QA tripwire did not block final action");
    notice.className = "tripwire";
    notice.textContent = "Final action blocked by QA tripwire";
    notice.focus();
    return true;
  } catch {
    notice.className = "infrastructure-error";
    notice.textContent = "Unable to confirm the QA tripwire";
    notice.focus();
    return false;
  }
}

async function activateClaimedFinalAction(
  stepId,
  lease,
  authorization,
  runToken,
  safetyChecks,
) {
  if (
    typeof stepId !== "string" ||
    !lease ||
    typeof lease.applicationRef !== "string" ||
    typeof lease.leaseId !== "string" ||
    ![1, 2].includes(lease.attempt) ||
    !authorization ||
    typeof authorization !== "object" ||
    !/^[a-f0-9]{64}$/.test(runToken) ||
    !safetyChecks ||
    Object.keys(safetyChecks).sort().join(",") !==
      "accountCreationRequired,captchaPresent,controlAccessible,loginRequired,mfaRequired,redirected"
  )
    throw new Error("Invalid private Auto-submit claim");
  const response = await fetch("/__qa/auto-submit/final-action", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-QA-Run-Token": runToken,
    },
    body: JSON.stringify({
      stepId,
      applicationRef: lease.applicationRef,
      leaseId: lease.leaseId,
      attempt: lease.attempt,
      authorization,
      safetyChecks,
    }),
  });
  if (!response.ok) throw new Error("Claimed Auto-submit action was refused");
  const confirmation = await response.json();
  if (
    !/^claim:[a-f0-9]{64}$/.test(confirmation.claimId) ||
    confirmation.source !== "isolated_loopback" ||
    confirmation.activationObserved !== true
  )
    throw new Error("Independent confirmation was unavailable");
  return confirmation;
}

function renderStep(fixture, stepId) {
  const step = fixture.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error("Fixture step is unavailable");
  currentStepId = step.id;
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
    return;
  }

  const form = document.createElement("form");
  form.noValidate = true;
  for (const control of step.controls) form.append(renderControl(control));
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Continue";
  form.append(button);
  const infrastructureError = document.createElement("p");
  infrastructureError.className = "infrastructure-error";
  infrastructureError.setAttribute("role", "alert");
  infrastructureError.setAttribute("aria-live", "assertive");
  form.append(infrastructureError);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    infrastructureError.textContent = "";
    try {
      if (!validateStep(step)) return;
      const retryingControlFailure = controlFailurePending;
      controlFailurePending = false;
      await ensureControlEvents(step);
      if (retryingControlFailure || controlFailurePending) {
        controlFailurePending = false;
        showInfrastructureError();
        return;
      }
      await recordEvent("advanced", "", step.id);
      const nextStep = fixture.steps.find(
        (candidate) => candidate.id === step.next,
      );
      if (nextStep?.kind === "review") {
        await recordEvent("reviewed", "", nextStep.id);
      }
      renderStep(fixture, step.next);
    } catch {
      showInfrastructureError();
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
  application.append(form);
}

Promise.all([fetch("/__qa/fixture"), fetch("/__qa/upload-policy")])
  .then(async ([fixtureResponse, policyResponse]) => {
    if (!fixtureResponse.ok || !policyResponse.ok)
      throw new Error("Fixture unavailable");
    return [await fixtureResponse.json(), await policyResponse.json()];
  })
  .then(([fixture, policy]) => {
    if (
      !policy ||
      typeof policy.expectedFilename !== "string" ||
      Object.keys(policy).length !== 1
    )
      throw new Error("Upload policy unavailable");
    expectedResumeFilename = policy.expectedFilename;
    fixtureData = fixture;
    renderStep(fixture, fixture.steps[0].id);
  })
  .catch(() => {
    application.textContent = "Application replay is unavailable.";
  });

export {
  activateClaimedFinalAction,
  activateFinalAction,
  recordEvent,
  renderControl,
  renderStep,
  validateStep,
};
