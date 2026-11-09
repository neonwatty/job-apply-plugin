import {
  assert,
  mkdtemp,
  rm,
  writeFile,
  tmpdir,
  join,
  spawn,
  spawnSync,
  test,
  chromium,
  REPO_ROOT,
  PYTHON,
  conflictingPaths,
  patchForPaths,
  pointerValue,
  summarizeProvenance,
} from "./workspace_test_support.mjs";

test("profile paths build selective patches and distinguish safe rebases from conflicts", () => {
  const base = { location: { city: "Phoenix", country: "US" }, skills: ["Python"], firstName: "Ada" };
  const latest = { location: { city: "Phoenix", country: "CA" }, skills: ["Python", "Rust"], firstName: "Grace" };
  const drafts = new Map([["/location/city", "Tempe"], ["/skills", ["Go"]], ["/firstName", "Augusta"]]);
  assert.equal(pointerValue(base, "/location/city"), "Phoenix");
  assert.deepEqual(patchForPaths(drafts), { location: { city: "Tempe" }, skills: ["Go"], firstName: "Augusta" });
  assert.deepEqual(conflictingPaths(base, latest, drafts, new Set(["/skills"])), ["/skills", "/firstName"]);
  const draftBases = new Map([["/firstName", "Ada"]]);
  assert.deepEqual(conflictingPaths(draftBases, latest, new Map([["/firstName", "Augusta"]])), ["/firstName"]);
});

test("profile pointer patches preserve forward-compatible prototype-shaped keys", () => {
  const patch = patchForPaths(new Map([
    ["/__proto__", { enabled: true }],
    ["/constructor/prototype", "kept"],
  ]));

  assert.equal(Object.hasOwn(patch, "__proto__"), true);
  assert.deepEqual(patch.__proto__, { enabled: true });
  assert.equal(Object.hasOwn(patch, "constructor"), true);
  assert.equal(patch.constructor.prototype, "kept");
  assert.equal(pointerValue({}, "/__proto__"), undefined);
  assert.deepEqual(pointerValue(JSON.parse('{"__proto__":{"enabled":true}}'), "/__proto__"), { enabled: true });
  assert.equal({}.enabled, undefined);
  assert.equal({}.kept, undefined);
});

test("atomic Additional provenance summarizes descendant sources", () => {
  assert.deepEqual(
    summarizeProvenance({
      "/futureConfig/enabled": { source: "resume", updatedAt: "2026-01-01T00:00:00Z" },
      "/futureConfig/note": { source: "user", updatedAt: "2026-01-02T00:00:00Z" },
    }, "/futureConfig"),
    { source: "mixed: resume, user", updatedAt: "2026-01-02T00:00:00Z" },
  );
});


test("Facts saved views organize canonical paths without owning facts", { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "fact-groups-browser-"));
  const storeRoot = join(temporary, "store");
  const storeScript = join(REPO_ROOT, "scripts", "job-apply-store.py");
  let inputCounter = 0;
  const cli = async (command, args = [], payload) => {
    const finalArgs = [storeScript, "--root", storeRoot, command, ...args];
    if (payload !== undefined) {
      const inputPath = join(temporary, `fact-group-${inputCounter++}.json`);
      await writeFile(inputPath, JSON.stringify(payload)); finalArgs.push("--input", inputPath);
    }
    const result = spawnSync(PYTHON, finalArgs, { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`); return JSON.parse(result.stdout);
  };
  const waitForStartup = (child) => new Promise((resolveStartup, rejectStartup) => {
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => rejectStartup(new Error(`workspace startup timed out: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => { stdout += chunk; const newline = stdout.indexOf("\n"); if (newline < 0) return; clearTimeout(timer); try { resolveStartup(JSON.parse(stdout.slice(0, newline))); } catch (error) { rejectStartup(error); } });
    child.once("exit", (code) => { clearTimeout(timer); rejectStartup(new Error(`workspace exited during startup (${code}): ${stderr}`)); });
  });

  let server; let browser;
  try {
    const profile = await cli("profile-replace", ["--expected-revision", "0", "--source", "user"], {
      firstName: "Synthetic", location: { city: "Phoenix", country: "US" }, skills: ["Python"], futureFact: { enabled: true },
    });
    const agentGroup = await cli("fact-group-create", [], { label: "Agent shortlist", paths: ["/firstName", "/skills"], order: 10 });
    server = spawn(PYTHON, [join(REPO_ROOT, "scripts", "job-apply-workspace.py"), "--root", storeRoot, "--port", "0", "--no-open", "--json"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const startup = await waitForStartup(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage(); const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error));
    await page.addInitScript(() => { globalThis.setInterval = () => 0; });
    await page.goto(startup.url); await page.getByText("Canonical store connected").waitFor();
    await page.getByRole("button", { name: "Facts", exact: true }).click();
    await page.getByRole("button", { name: "Agent shortlist" }).waitFor();

    const noticeContrast = await page.locator("#facts-status").evaluate((element) => {
      const style = getComputedStyle(element); const parse = (value) => value.match(/[\d.]+/g).slice(0, 3).map(Number);
      const luminance = (rgb) => { const channels = rgb.map((value) => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }); return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]; };
      const foreground = luminance(parse(style.color)); const background = luminance(parse(style.backgroundColor));
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    assert.ok(noticeContrast >= 7, `notice contrast was ${noticeContrast}`);

    await page.getByRole("button", { name: "Identity & contact" }).click();
    assert.equal(await page.locator('#facts-form [data-fact-section]:not(.fact-view-hidden)').count(), 1);
    await page.getByLabel("First name").fill("Draft survives views");
    await page.getByRole("button", { name: "Agent shortlist" }).click();
    assert.equal(await page.getByLabel("First name").inputValue(), "Draft survives views");
    assert.equal(await page.getByLabel("Skills (one per line)").isVisible(), true);
    assert.equal(await page.locator("#work-history").locator("xpath=ancestor::section[1]").getAttribute("data-fact-path-hidden"), "");

    await page.getByRole("button", { name: "New group" }).click();
    await page.getByLabel("Group name").fill("Location shortlist");
    await page.locator('#fact-group-paths input[value="/location/city"]').check();
    await page.locator('#fact-group-paths input[value="/location/country"]').check();
    await page.getByRole("button", { name: "Save group" }).click();
    await page.getByRole("button", { name: "Location shortlist" }).waitFor();
    let groups = await cli("fact-group-list");
    const browserGroup = groups.find((group) => group.label === "Location shortlist");
    assert.deepEqual(browserGroup.paths, ["/location/city", "/location/country"]);

    await page.getByRole("button", { name: "Edit group" }).click();
    await page.getByLabel("Group name").fill("Location essentials");
    await page.getByLabel("Display order").fill("5");
    await page.getByRole("button", { name: "Save group" }).click();
    await page.getByRole("button", { name: "Location essentials" }).waitFor();
    groups = await cli("fact-group-list");
    const renamed = groups.find((group) => group.id === browserGroup.id);
    assert.equal(renamed.label, "Location essentials"); assert.equal(renamed.order, 5);

    await page.getByRole("button", { name: "Agent shortlist" }).click();
    await page.getByRole("button", { name: "Edit group" }).click();
    await cli("fact-group-update", ["--id", agentGroup.id, "--expected-revision", String(agentGroup.revision)], { label: "Agent canonical" });
    await page.getByLabel("Group name").fill("Stale browser label");
    await page.getByRole("button", { name: "Save group" }).click();
    await page.getByRole("heading", { name: "This group changed elsewhere" }).waitFor();
    assert.equal((await cli("fact-group-get", ["--id", agentGroup.id])).label, "Agent canonical");
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Location essentials" }).click();
    await page.getByRole("button", { name: "Edit group" }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Remove group" }).click();
    await page.getByRole("button", { name: "Location essentials" }).waitFor({ state: "detached" });
    assert.equal((await cli("fact-group-list")).some((group) => group.id === browserGroup.id), false);
    const finalProfile = await cli("profile-inspect");
    assert.deepEqual(finalProfile.profile, profile.profile);
    assert.equal(pageErrors.length, 0, pageErrors.map(String).join("\n"));
  } finally {
    if (browser) await browser.close();
    if (server && server.exitCode === null) { server.kill("SIGINT"); await new Promise((resolveExit) => server.once("exit", resolveExit)); }
    await rm(temporary, { recursive: true, force: true });
  }
});
