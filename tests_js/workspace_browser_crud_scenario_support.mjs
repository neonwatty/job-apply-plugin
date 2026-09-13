import {
  assert, join, mkdtemp, PYTHON, REPO_ROOT, rm, spawn, spawnSync, tmpdir, writeFile,
} from "./workspace_test_support.mjs";

export async function createBrowserCrudScenario() {
  const temporary = await mkdtemp(join(tmpdir(), "job-workspace-browser-"));
  const storeRoot = join(temporary, "store");
  const storeScript = join(REPO_ROOT, "scripts", "job-apply-store.py");
  let inputCounter = 0;
  const cli = async (command, args = [], payload) => {
    const finalArgs = [storeScript, "--root", storeRoot, command, ...args];
    if (payload !== undefined) {
      const inputPath = join(temporary, `input-${inputCounter++}.json`);
      await writeFile(inputPath, JSON.stringify(payload));
      finalArgs.push("--input", inputPath);
    }
    const result = spawnSync(PYTHON, finalArgs, { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const waitForStartup = (child) => new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`workspace startup timed out: ${stderr}`)), 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(stdout.slice(0, newline))); } catch (error) { reject(error); }
      }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`workspace exited during startup (${code}): ${stderr}`)); });
  });

  let server;
  let browser;
  return { temporary, storeRoot, cli, waitForStartup, server, browser };
}

export async function cleanupBrowserCrudScenario(context) {
  const { temporary } = context;
  const { browser, server } = context;
    if (browser) await browser.close();
    if (server && server.exitCode === null) {
      server.kill("SIGINT");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    await rm(temporary, { recursive: true, force: true });
}
