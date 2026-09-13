import { test } from "node:test";
import { BrokerClient, EventEmitter, abortCheckpointClient, access, assert, captureFullPagePng, chmod, chromium, commitCheckpoint, createHash, decodeCapturedPng, exerciseRejectedCaptureStates, http, inspectionHasSensitivePage, isSensitivePage, mkdir, mkdtemp, mockCaptureIsolated, once, path, postControl, readFile, readdir, rename, rm, root, runLauncher, runNode, sanitizeObservedControl, sendSlowPartialBody, spawn, startIndependentChromium, startPartialBody, startSyntheticSite, stat, stopChild, symlink, tmpdir, validateCaptureResources, validateCheckpointKind, validateRecorderOptions, validateSafetyRevision, waitForDevToolsActivePort, waitForExit, waitForFile, waitForInitialPageTarget, withTimeout, writeFile } from "./recorder_test_support.mjs";

test("sensitive page detector rejects login and credential surfaces", () => {
  assert.equal(
    isSensitivePage({
      url: "https://example.test/join",
      title: "Account creation",
      controls: [],
      text: "",
    }),
    true,
  );
  for (const text of [
    "Complete CAPTCHA verification",
    "Enter your MFA code",
    "Approve the authenticator app push notification",
    "Enter the SMS security code",
    "Use a recovery code for 2FA",
    "Verify your identity",
    "Enter the 6-digit code we sent",
  ]) {
    assert.equal(isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [],
      text,
    }), true);
  }
  for (const autocomplete of ["current-password", "one-time-code"]) {
    assert.equal(isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [{ type: "text", label: "Code", autocomplete }],
      text: "",
    }), true);
  }
  for (const text of ["OTP", "Authentication challenge", "Use your security key"]) {
    assert.equal(isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [],
      text,
    }), true);
  }
  assert.equal(
    isSensitivePage({
      url: "https://example.test/jobs/1",
      title: "Sign in to continue",
      controls: [],
      text: "",
    }),
    true,
  );
  assert.equal(
    isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [{ type: "password", label: "Access phrase" }],
      text: "",
    }),
    true,
  );
  assert.equal(
    isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [{ type: "email", label: "Email" }],
      text: "Apply for this position",
    }),
    false,
  );
  assert.equal(
    isSensitivePage({
      url: "https://example.test/jobs/1/apply",
      title: "Application",
      controls: [],
      text: "Solve difficult technical challenges with the engineering team",
    }),
    false,
  );
});

test("Workday permits only a bounded ordinary shell around one optional Sign In", () => {
  const control = (label, overrides = {}) => ({
    type: "button",
    autocomplete: "",
    label,
    role: "button",
    required: false,
    ...overrides,
  });
  const signIn = control("Sign In");
  const applyAnchor = control("Unlabelled control", { type: "a" });
  const ordinaryPairs = [
    ["button", "button"],
    ["svg", "presentation"],
    ["span", "alert"],
    ["a", "button"],
    ["div", "button"],
    ["div", "search"],
    ["nav", "menu"],
    ["text", "textbox"],
  ];
  const ordinary = (index) => {
    const [type, role] = ordinaryPairs[index % ordinaryPairs.length];
    return control(type === "button" ? `Ordinary action ${index}` : "Unlabelled control", {
      type,
      role,
    });
  };
  const controls = [signIn, applyAnchor];
  while (controls.length < 26) controls.push(ordinary(controls.length));
  const securityControls = [...controls];
  while (securityControls.length < 41) securityControls.push(ordinary(securityControls.length));
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://fictional.wd5.myworkdayjobs.com/en-US/fictional-site/job/Fictional-Role_JR-000001",
      title: "Fictional Role",
      text: "Fictional Role Sign In Apply",
      controls,
      securityControls,
      controlOverflow: false,
      formCount: 0,
      securityFrames: [],
      securityFrameOverflow: false,
    },
  };
  const inspect = (value = main.value, extras = [], boundUrl = undefined) =>
    inspectionHasSensitivePage([{ ...main, value }, ...extras], boundUrl);

  assert.equal(inspect(), false);
  const wd1Value = {
    ...main.value,
    url: "https://fictional.wd1.myworkdayjobs.com/en-US/fictional-site/job/fictional-location/Fictional-Role_JR000001-1",
  };
  assert.equal(inspect(wd1Value), false);
  const choiceControls = [...controls,
    control("Start Your Application", { type: "section", role: "dialog" }),
    control("Autofill with Resume"),
    control("Apply Manually"),
    control("Use My Last Application"),
  ];
  const choiceSecurityControls = [...securityControls, ...choiceControls.slice(-4)];
  assert.equal(inspect({
    ...main.value,
    text: "Fictional Role Sign In Apply Start Your Application Autofill with Resume Apply Manually Use My Last Application",
    controls: choiceControls,
    securityControls: choiceSecurityControls,
  }), false);

  const invalidValues = [
    { ...main.value, url: main.value.url.replace("wd5", "wd2") },
    { ...main.value, url: main.value.url.replace("wd5", "wd4") },
    { ...main.value, url: main.value.url.replace("wd5", "wd6") },
    { ...main.value, url: main.value.url.replace("_JR-000001", "_R000001") },
    { ...main.value, url: main.value.url.replace("_JR-000001", "_JR000001") },
    { ...main.value, url: main.value.url.replace("fictional.wd5", `${"a".repeat(64)}.wd5`) },
    { ...main.value, url: main.value.url.replace("fictional-site", "fictional.site") },
    { ...main.value, url: main.value.url.replace("fictional-site", `${"s".repeat(65)}`) },
    { ...main.value, url: main.value.url.replace("Fictional-Role", "Fictional%2FRole") },
    { ...main.value, url: main.value.url.replace("Fictional-Role", `${"r".repeat(129)}`) },
    { ...main.value, url: `${main.value.url}?source=private` },
    { ...main.value, url: `${main.value.url}#application` },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "_JR-000001-1") },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "_JR000001_1") },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "_JR000001") },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "_JR000001-") },
    { ...wd1Value, url: wd1Value.url.replace("_JR000001-1", "") },
    { ...wd1Value, url: wd1Value.url.replace("000001-1", `${"1".repeat(19)}-1`) },
    { ...wd1Value, url: wd1Value.url.replace("000001-1", `000001-${"1".repeat(19)}`) },
    { ...wd1Value, url: wd1Value.url.replace("/Fictional-Role_", "/extra/Fictional-Role_") },
    { ...wd1Value, url: `${wd1Value.url}?source=private` },
    { ...wd1Value, url: `${wd1Value.url}#application` },
    { ...wd1Value, url: wd1Value.url.replace("wd1", "wd2") },
    { ...wd1Value, url: wd1Value.url.replace("wd1", "wd5") },
    { ...wd1Value, url: main.value.url.replace("wd5", "wd1") },
    { ...main.value, text: `${main.value.text} Create an account` },
    { ...main.value, text: `${main.value.text} Complete CAPTCHA verification` },
    { ...main.value, text: main.value.text.replace("Apply", "Apply Now") },
    { ...main.value, text: `${main.value.text} Apply Manually` },
    { ...main.value, controls: controls.filter((item) => item !== signIn) },
    { ...main.value, securityControls: securityControls.filter((item) => item !== signIn) },
    { ...main.value, controls: [signIn, ...controls] },
    { ...main.value, securityControls: [signIn, ...securityControls] },
    { ...main.value, securityControls: [...securityControls, {
      type: "password",
      autocomplete: "current-password",
      label: "Password",
      role: "textbox",
      required: true,
    }] },
    { ...main.value, securityControls: securityControls.map((item, index) =>
      index === 2 ? { ...item, type: "section", role: "navigation" } : item) },
    { ...main.value, controls: [...controls, ...Array.from({ length: 7 }, (_, index) =>
      ordinary(100 + index))] },
    { ...main.value, securityControls: [...securityControls,
      ...Array.from({ length: 8 }, (_, index) => ordinary(200 + index))] },
    { ...main.value, securityFrames: [{
      src: "about:blank",
      title: "",
      visibility: "hidden",
      position: "absolute",
      width: 1,
      height: 1,
    }] },
    { ...main.value, securityFrameOverflow: true },
    { ...main.value, controlOverflow: true },
    { ...main.value, formCount: 1 },
  ];
  for (const [index, value] of invalidValues.entries()) {
    assert.equal(inspect(value), true, `invalid Workday shape ${index}`);
  }
  for (const url of [
    main.value.url.replace("fictional", "other-tenant"),
    main.value.url.replace("/fictional-site/", "/other-site/"),
    main.value.url.replace("/Fictional-Role_", "/Other-Role_"),
  ]) {
    assert.equal(inspect({ ...main.value, url }, [], main.value.url), true, url);
  }
  assert.equal(inspect(main.value, [{
    frame: { id: "child", parentId: "main" },
    frameVisible: false,
    value: {
      url: "about:blank",
      title: "",
      text: "",
      controls: [],
      securityControls: [],
      controlOverflow: false,
    },
  }]), true);
});

test("LinkedIn jobs allow only an inert hidden CAPTCHA bootstrap frame", () => {
  const main = {
    frame: { id: "main" },
    frameVisible: true,
    value: {
      url: "https://www.linkedin.com/jobs/view/4450809022/",
      title: "AI Engineer | LinkedIn",
      text: "Solve difficult technical challenges. Easy Apply",
      controls: [{ type: "button", label: "Easy Apply" }],
      securityControls: [],
    },
  };
  const dormantCaptcha = {
    frame: { id: "captcha", parentId: "main" },
    frameVisible: false,
    value: {
      url: "",
      title: "CAPTCHA",
      text: "CAPTCHA",
      controls: [],
      securityControls: [],
    },
  };
  const dormantCaptchaResponse = {
    frame: { id: "captcha-response", parentId: "captcha" },
    frameVisible: false,
    value: {
      url: "https://www.google.com/recaptcha/api2/anchor",
      title: "",
      text: "",
      controls: [{
        type: "textarea",
        autocomplete: "",
        label: "g-recaptcha-response",
      }],
      securityControls: [],
    },
  };

  assert.equal(inspectionHasSensitivePage([
    main,
    dormantCaptcha,
    dormantCaptchaResponse,
  ]), false);
  assert.equal(inspectionHasSensitivePage([
    main,
    { ...dormantCaptcha, frameVisible: true },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    dormantCaptcha,
    { ...dormantCaptchaResponse, frameVisible: true },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    { ...main, value: { ...main.value, url: "https://example.test/jobs/1" } },
    dormantCaptcha,
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...dormantCaptcha,
      value: {
        ...dormantCaptcha.value,
        controls: [{ type: "button", label: "Reload CAPTCHA" }],
      },
    },
  ]), false);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...dormantCaptcha,
      value: {
        ...dormantCaptcha.value,
        controls: [{ type: "password", label: "CAPTCHA response" }],
      },
    },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    main,
    {
      ...dormantCaptcha,
      value: { ...dormantCaptcha.value, title: "Sign in", text: "Sign in" },
    },
  ]), true);
  assert.equal(inspectionHasSensitivePage([
    {
      ...main,
      value: {
        ...main.value,
        url: "https://www.linkedin.com/checkpoint/challengesV2/opaque",
        title: "Verify your identity",
        text: "Approve this sign-in",
      },
    },
  ]), true);
});
