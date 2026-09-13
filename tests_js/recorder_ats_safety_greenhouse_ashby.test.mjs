import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("Greenhouse jobs allow only passive reCAPTCHA disclosure surfaces", () => {
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://job-boards.greenhouse.io/tubitv/jobs/7702258",
      title: "Machine Learning Engineer | Tubi",
      text: "Apply for this job. This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.",
      controls: [
        { type: "email", label: "Email" },
        { type: "button", label: "Submit application" },
      ],
      securityControls: [],
    },
  };
  const passiveBadge = {
    frame: { id: "recaptcha-badge", parentId: "main" },
    frameVisible: true,
    value: {
      url: "https://www.google.com/recaptcha/api2/anchor?ar=1&k=public-site-key",
      title: "reCAPTCHA",
      text: "Privacy - Terms",
      controls: [],
      securityControls: [],
    },
  };

  assert.equal(inspectionHasSensitivePage([main, passiveBadge]), false);
  const hiddenResponseOnly = {
    ...main,
    value: {
      ...main.value,
      text: "Apply for this job",
      securityControls: [{
        type: "textarea",
        role: "textbox",
        autocomplete: "",
        label: "g-recaptcha-response",
      }],
    },
  };
  assert.equal(inspectionHasSensitivePage([hiddenResponseOnly]), false);
  assert.equal(inspectionHasSensitivePage([{
    ...hiddenResponseOnly,
    value: {
      ...hiddenResponseOnly.value,
      controls: hiddenResponseOnly.value.securityControls,
    },
  }]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...passiveBadge,
      value: {
        ...passiveBadge.value,
        controls: [{ type: "checkbox", label: "I'm not a robot" }],
      },
    },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...passiveBadge,
      value: {
        ...passiveBadge.value,
        url: "https://www.google.com/recaptcha/api2/bframe?hl=en",
        title: "reCAPTCHA challenge",
        text: "Select all images with traffic lights",
      },
    },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    {
      ...main,
      value: { ...main.value, text: "Complete CAPTCHA verification to apply" },
    },
    passiveBadge,
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    { ...main, value: { ...main.value, url: "https://example.test/jobs/7702258" } },
    passiveBadge,
  ]), true);
});

test("Ashby applications allow only one passive hidden response and empty child frame", () => {
  const response = {
    type: "textarea",
    role: "textbox",
    autocomplete: "",
    label: "g-recaptcha-response",
  };
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application",
      title: "Application",
      text: "Apply for this position",
      controls: [
        { type: "email", role: "textbox", autocomplete: "", label: "Email" },
        { type: "button", role: "button", autocomplete: "", label: "Continue" },
      ],
      securityControls: [
        { type: "email", role: "textbox", autocomplete: "", label: "Email" },
        { type: "button", role: "button", autocomplete: "", label: "Continue" },
        response,
      ],
      controlOverflow: false,
    },
  };
  const emptyChild = {
    frame: { id: "passive", parentId: "main" },
    frameVisible: false,
    value: {
      url: "about:blank",
      title: "",
      text: "",
      controls: [],
      securityControls: [],
      controlOverflow: false,
    },
  };
  const inspect = (mainValue = main.value, childValue = emptyChild.value, extras = []) =>
    inspectionHasSensitivePage([
      { ...main, value: mainValue },
      { ...emptyChild, value: childValue },
      ...extras,
    ]);

  assert.equal(inspect(), false);

  const invalidUrls = [
    "http://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application",
    "https://user@jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application",
    "https://jobs.ashbyhq.com:444/example/00000000-0000-4000-8000-000000000001/application",
    "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application?source=test",
    "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001/application#form",
    "https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001",
    "https://jobs.ashbyhq.com/application",
    "https://example.test/example/00000000-0000-4000-8000-000000000001/application",
  ];
  for (const url of invalidUrls) {
    assert.equal(inspect({ ...main.value, url }), true, url);
  }

  const invalidMainShapes = [
    {
      ...main.value,
      controls: [...main.value.controls, response],
    },
    {
      ...main.value,
      controls: [...main.value.controls, {
        type: "checkbox", role: "checkbox", autocomplete: "", label: "I'm not a robot",
      }],
    },
    {
      ...main.value,
      controls: [...main.value.controls, {
        type: "button", role: "button", autocomplete: "", label: "Start challenge",
      }],
    },
    {
      ...main.value,
      securityControls: [...main.value.securityControls, response],
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === response ? { ...response, role: "control" } : control),
    },
    {
      ...main.value,
      securityControls: [...main.value.securityControls, {
        type: "password", role: "textbox", autocomplete: "current-password", label: "Password",
      }],
    },
    { ...main.value, text: "Complete CAPTCHA verification" },
    { ...main.value, text: "Authentication required" },
    { ...main.value, text: "Sign in to continue" },
  ];
  for (const value of invalidMainShapes) {
    assert.equal(inspect(value), true);
  }

  const invalidChildShapes = [
    { ...emptyChild.value, url: "https://example.test/frame" },
    { ...emptyChild.value, title: "Challenge" },
    { ...emptyChild.value, text: "Complete CAPTCHA verification" },
    {
      ...emptyChild.value,
      controls: [{ type: "checkbox", role: "checkbox", label: "I'm not a robot" }],
    },
    {
      ...emptyChild.value,
      securityControls: [{ type: "password", role: "textbox", label: "Password" }],
    },
  ];
  for (const value of invalidChildShapes) {
    assert.equal(inspect(main.value, value), true);
  }

  assert.equal(inspectionHasSensitivePage([main]), true);
  assert.equal(inspect(main.value, emptyChild.value, [{
    frame: { id: "unexpected", parentId: "main" },
    frameVisible: false,
    value: { ...emptyChild.value },
  }]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    { ...emptyChild, frame: { id: "passive", parentId: "other" } },
  ]), true);
});
