import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("Lever applications allow only the exact passive hidden hCaptcha bootstrap", () => {
  const textareaResponse = (label) => ({
    type: "textarea",
    role: "textbox",
    autocomplete: "",
    label,
    required: false,
  });
  const gResponse = textareaResponse("g-recaptcha-response");
  const hResponse = textareaResponse("h-captcha-response");
  const mainResponse = {
    ...hResponse,
    type: "hidden",
  };
  const visibleControls = [
    { type: "email", role: "textbox", autocomplete: "email", label: "Email" },
    { type: "button", role: "button", autocomplete: "", label: "Submit application" },
  ];
  const enclaveVersion = "a".repeat(40);
  const enclaveOwner = (channel) => ({
    src: `https://newassets.hcaptcha.com/captcha/v1/${enclaveVersion}/static/hcaptcha-enclave.html` +
      `#frame=enclave&_channel=${channel}&_origin=https%3A%2F%2Fjobs.lever.co` +
      `&host=jobs.lever.co&se=${enclaveVersion}`,
    title: "Widget containing checkbox for hCaptcha security challenge",
    visibility: "hidden",
    position: "fixed",
    width: 300,
    height: 200,
  });
  const auxiliaryOwner = {
    src: "",
    title: "",
    visibility: "hidden",
    position: "absolute",
    width: 1,
    height: 1,
  };
  const securityFrames = [
    auxiliaryOwner,
    enclaveOwner("ChannelOne1"),
    enclaveOwner("ChannelTwo2"),
  ];
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
      title: "Application",
      text: "Apply for this position",
      controls: visibleControls,
      securityControls: [...visibleControls, mainResponse],
      controlOverflow: false,
      securityFrames,
      securityFrameOverflow: false,
    },
  };
  const auxiliary = {
    frame: { id: "auxiliary", parentId: "main" },
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
  const hcaptchaChild = (id) => ({
    frame: { id, parentId: "main" },
    frameVisible: false,
    value: {
      url: "",
      title: "hCaptcha",
      text: "",
      controls: [],
      securityControls: [gResponse, hResponse],
      controlOverflow: false,
    },
  });
  const hcaptchaChildren = [hcaptchaChild("hcaptcha-one"), hcaptchaChild("hcaptcha-two")];
  const children = [auxiliary, ...hcaptchaChildren];
  const inspect = (mainValue = main.value, childValues = [auxiliary], extras = []) =>
    inspectionHasSensitivePage([
      { ...main, value: mainValue },
      ...childValues,
      ...extras,
    ]);

  assert.equal(inspect(), false);
  assert.equal(inspect(main.value, children), false);

  const invalidUrls = [
    "http://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
    "https://user@jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
    "https://user:secret@jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
    "https://jobs.lever.co:444/example/00000000-0000-4000-8000-000000000001/apply",
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply?source=test",
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply#form",
    "https://www.jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply",
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001",
    "https://jobs.lever.co/example/apply",
    "https://jobs.lever.co/example/00000000-0000-4000-8000-000000000001/apply/extra",
    "https://example.test/example/00000000-0000-4000-8000-000000000001/apply",
  ];
  for (const url of invalidUrls) {
    assert.equal(inspect({ ...main.value, url }), true, url);
  }

  const invalidMainShapes = [
    { ...main.value, controlOverflow: true },
    { ...main.value, controls: [...visibleControls, mainResponse] },
    { ...main.value, securityControls: visibleControls },
    { ...main.value, securityControls: [...main.value.securityControls, mainResponse] },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse
          ? { ...mainResponse, label: "g-recaptcha-response" }
          : control),
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse ? { ...mainResponse, type: "textarea" } : control),
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse ? { ...mainResponse, role: "control" } : control),
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse ? { ...mainResponse, autocomplete: "off" } : control),
    },
    {
      ...main.value,
      securityControls: main.value.securityControls.map((control) =>
        control === mainResponse ? { ...mainResponse, required: true } : control),
    },
    {
      ...main.value,
      controls: [...visibleControls, {
        type: "checkbox", role: "checkbox", autocomplete: "", label: "I'm not a robot",
      }],
    },
    {
      ...main.value,
      controls: [...visibleControls, {
        type: "button", role: "button", autocomplete: "", label: "Start CAPTCHA challenge",
      }],
    },
    {
      ...main.value,
      securityControls: [...main.value.securityControls, {
        type: "password", role: "textbox", autocomplete: "current-password", label: "Password",
      }],
    },
    {
      ...main.value,
      controls: [...visibleControls, {
        type: "text", role: "textbox", autocomplete: "one-time-code", label: "Code",
      }],
    },
    { ...main.value, text: "Sign in to continue" },
    { ...main.value, text: "Create an account" },
    { ...main.value, text: "Enter your MFA code" },
    { ...main.value, text: "Complete CAPTCHA verification" },
  ];
  for (const [index, value] of invalidMainShapes.entries()) {
    assert.equal(inspect(value), true, `invalid Lever main shape ${index}`);
  }

  const mutateEnclaveUrl = (mutate) => {
    const url = new URL(enclaveOwner("ChannelOne1").src);
    mutate(url);
    return url.toString();
  };
  const mutateFragment = (name, value) => mutateEnclaveUrl((url) => {
    const params = new URLSearchParams(url.hash.slice(1));
    params.set(name, value);
    url.hash = params.toString();
  });
  const invalidEnclaveUrls = [
    mutateEnclaveUrl((url) => { url.protocol = "http:"; }),
    mutateEnclaveUrl((url) => { url.hostname = "assets.hcaptcha.com"; }),
    mutateEnclaveUrl((url) => { url.pathname = "/captcha/v1/not-a-version/static/hcaptcha-enclave.html"; }),
    mutateEnclaveUrl((url) => { url.pathname = `/captcha/v2/${enclaveVersion}/static/hcaptcha-enclave.html`; }),
    mutateEnclaveUrl((url) => { url.pathname = `/captcha/v1/${"a".repeat(39)}/static/hcaptcha-enclave.html`; }),
    mutateEnclaveUrl((url) => { url.username = "user"; }),
    mutateEnclaveUrl((url) => { url.password = "secret"; }),
    mutateEnclaveUrl((url) => { url.port = "444"; }),
    mutateEnclaveUrl((url) => { url.search = "?source=test"; }),
    mutateFragment("frame", "checkbox"),
    mutateFragment("_channel", "bad-channel"),
    mutateFragment("_origin", "https://example.test"),
    mutateFragment("host", "example.test"),
    mutateFragment("se", "b".repeat(40)),
    mutateEnclaveUrl((url) => {
      const params = new URLSearchParams(url.hash.slice(1));
      params.append("extra", "value");
      url.hash = params.toString();
    }),
  ];
  for (const src of invalidEnclaveUrls) {
    assert.equal(inspect({
      ...main.value,
      securityFrames: [auxiliaryOwner, { ...securityFrames[1], src }, securityFrames[2]],
    }), true, src);
  }

  const invalidOwnerInventories = [
    securityFrames.slice(0, 2),
    [...securityFrames, auxiliaryOwner],
    [auxiliaryOwner, { ...securityFrames[1], visibility: "visible" }, securityFrames[2]],
    [auxiliaryOwner, { ...securityFrames[1], position: "absolute" }, securityFrames[2]],
    [auxiliaryOwner, { ...securityFrames[1], width: 0 }, securityFrames[2]],
    [auxiliaryOwner, { ...securityFrames[1], height: 0 }, securityFrames[2]],
    [auxiliaryOwner, {
      ...securityFrames[1],
      title: "Widget containing hCaptcha challenge",
    }, securityFrames[2]],
    [{ ...auxiliaryOwner, src: "about:blank" }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, title: "Auxiliary" }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, visibility: "visible" }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, position: "fixed" }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, width: 2 }, ...securityFrames.slice(1)],
    [{ ...auxiliaryOwner, height: 0 }, ...securityFrames.slice(1)],
  ];
  for (const frames of invalidOwnerInventories) {
    assert.equal(inspect({ ...main.value, securityFrames: frames }), true);
  }
  assert.equal(inspect({ ...main.value, securityFrames: undefined }), true);
  assert.equal(inspect({ ...main.value, securityFrameOverflow: true }), true);

  const replaceFirstChild = (value, overrides = {}) => [
    auxiliary,
    { ...hcaptchaChildren[0], ...overrides, value },
    hcaptchaChildren[1],
  ];
  const invalidChildValues = [
    { ...hcaptchaChildren[0].value, url: "about:blank" },
    { ...hcaptchaChildren[0].value, url: "https://newassets.hcaptcha.com/captcha/v1/asset.html" },
    { ...hcaptchaChildren[0].value, title: "hCaptcha challenge" },
    { ...hcaptchaChildren[0].value, text: "Select all matching images" },
    { ...hcaptchaChildren[0].value, text: "Sign in to continue" },
    { ...hcaptchaChildren[0].value, controlOverflow: true },
    { ...hcaptchaChildren[0].value, controls: [gResponse, hResponse] },
    { ...hcaptchaChildren[0].value, securityControls: [hResponse] },
    { ...hcaptchaChildren[0].value, securityControls: [gResponse, hResponse, hResponse] },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [{ ...gResponse, role: "control" }, hResponse],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [{ ...gResponse, type: "text" }, hResponse],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [{ ...gResponse, label: "recaptcha-response" }, hResponse],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [gResponse, { ...hResponse, autocomplete: "one-time-code" }],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [gResponse, { ...hResponse, required: true }],
    },
    {
      ...hcaptchaChildren[0].value,
      securityControls: [gResponse, hResponse, {
        type: "password", role: "textbox", autocomplete: "current-password", label: "Password",
      }],
    },
    {
      ...hcaptchaChildren[0].value,
      controls: [{ type: "checkbox", role: "checkbox", label: "I'm not a robot" }],
    },
  ];
  for (const value of invalidChildValues) {
    assert.equal(inspect(main.value, replaceFirstChild(value)), true);
  }

  assert.equal(inspect(main.value, [
    auxiliary,
    { ...hcaptchaChildren[0], frameVisible: true },
    hcaptchaChildren[1],
  ]), true);
  assert.equal(inspect(main.value, [
    auxiliary,
    { ...hcaptchaChildren[0], frame: { id: "hcaptcha-one", parentId: "other" } },
    hcaptchaChildren[1],
  ]), true);
  const invalidAuxiliaryValues = [
    { ...auxiliary.value, url: "" },
    { ...auxiliary.value, title: "Auxiliary" },
    { ...auxiliary.value, text: "Loading" },
    { ...auxiliary.value, controls: [{ type: "button", role: "button", label: "Continue" }] },
    { ...auxiliary.value, securityControls: [hResponse] },
    { ...auxiliary.value, controlOverflow: true },
  ];
  for (const value of invalidAuxiliaryValues) {
    assert.equal(inspect(main.value, [
      { ...auxiliary, value },
      ...hcaptchaChildren,
    ]), true);
  }
  assert.equal(inspect(main.value, [
    { ...auxiliary, frameVisible: true },
    ...hcaptchaChildren,
  ]), true);
  assert.equal(inspect(main.value, hcaptchaChildren), true);
  assert.equal(inspect(main.value, [auxiliary, hcaptchaChildren[0]]), true);
  assert.equal(inspect(main.value, children, [hcaptchaChild("hcaptcha-three")]), true);
  assert.equal(inspect(main.value, children, [{
    frame: { id: "sensitive", parentId: "main" },
    frameVisible: false,
    value: {
      url: "about:blank",
      title: "Sign in",
      text: "Authentication required",
      controls: [],
      securityControls: [],
      controlOverflow: false,
    },
  }]), true);
});
