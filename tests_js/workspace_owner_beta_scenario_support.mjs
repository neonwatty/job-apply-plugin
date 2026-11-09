import {
  assert, chromium, join, mkdtemp, PYTHON, REPO_ROOT, rm, spawn, spawnSync, tmpdir, writeFile,
} from "./workspace_test_support.mjs";

export async function createOwnerBetaScenario() {
  const temporary = await mkdtemp(join(tmpdir(), "job-owner-beta-"));
  const storeRoot = join(temporary, "store");
  const storeScript = join(REPO_ROOT, "scripts", "job-apply-store.py");
  let inputCounter = 0;
  const cli = async (command, args = [], payload) => {
    const finalArgs = [storeScript, "--root", storeRoot, command, ...args];
    if (payload !== undefined) {
      const inputPath = join(temporary, `owner-input-${inputCounter++}.json`);
      await writeFile(inputPath, JSON.stringify(payload));
      finalArgs.push("--input", inputPath);
    }
    const result = spawnSync(PYTHON, finalArgs, { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const waitForStartup = (child) => new Promise((resolveStartup, rejectStartup) => {
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => rejectStartup(new Error(`workspace startup timed out: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk; const newline = stdout.indexOf("\n"); if (newline < 0) return;
      clearTimeout(timer);
      try { resolveStartup(JSON.parse(stdout.slice(0, newline))); } catch (error) { rejectStartup(error); }
    });
    child.once("exit", (code) => { clearTimeout(timer); rejectStartup(new Error(`workspace exited during startup (${code}): ${stderr}`)); });
  });
  const launch = async () => {
    const child = spawn(PYTHON, [join(REPO_ROOT, "scripts", "job-apply-workspace.py"), "--root", storeRoot, "--port", "0", "--no-open", "--json"], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    return { child, startup: await waitForStartup(child) };
  };
  const stop = async (child) => {
    child.kill("SIGINT");
    assert.equal(await new Promise((resolveExit) => child.once("exit", resolveExit)), 0);
  };

  let running; let browser;
  return { temporary, storeRoot, cli, launch, stop, running, browser };
}

export async function startOwnerBetaScenario(context) {
  let { running, browser } = context;
  const { launch } = context;
    running = await launch();
  context.running = running;
    browser = await chromium.launch({ headless: true });
  context.browser = browser;
}

export async function cleanupOwnerBetaScenario(context) {
  const { temporary, stop } = context;
  const { running, browser } = context;
    if (browser) await browser.close();
    if (running?.child && running.child.exitCode === null) await stop(running.child);
    await rm(temporary, { recursive: true, force: true });
}
