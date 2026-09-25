#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const supportedPythonAliases = ["python3.12", "python3.13", "python3.14"];
export const supportedPythonProfiles = [
  { alias: "python3.12", version: "3.12.13" },
  { alias: "python3.13", version: "3.13.13" },
  { alias: "python3.14", version: "3.14.4" },
];

export function selectMacSdk({
  platform = process.platform,
  probe = (args) => execFileSync("/usr/bin/xcrun", args,
    { encoding: "utf8", timeout: 3000, maxBuffer: 4096 }),
} = {}) {
  if (platform !== "darwin") return null;
  const path = probe(["--show-sdk-path"]).trim();
  const compiler = probe(["--find", "clang"]).trim();
  if (!isAbsolute(path) || !isAbsolute(compiler)) {
    throw new Error("Broad QA requires absolute SDK and Clang paths from xcrun");
  }
  return { path, compiler: realpathSync(compiler) };
}

export function selectSupportedPythonProfiles({
  platform = process.platform,
  discover = (version) => {
    try { return execFileSync("uv", ["python", "find", version],
      { encoding: "utf8", timeout: 3000, maxBuffer: 4096 }).trim(); }
    catch { return null; }
  },
  probe = (executable) => execFileSync(executable, ["-I", "-B", "-c",
    "import json,platform,sys; print(json.dumps({'implementation':platform.python_implementation(),'version':platform.python_version(),'profile':f'{sys.version_info.major}.{sys.version_info.minor}','executable':sys.executable}))"],
  { encoding: "utf8", timeout: 3000, maxBuffer: 4096 }),
} = {}) {
  if (platform !== "darwin") return null;
  const selections = [];
  for (const expected of supportedPythonProfiles) {
    let selection = null;
    const candidates = [...new Set([discover(expected.version), expected.alias].filter(Boolean))];
    for (const candidate of candidates) {
      try {
        const receipt = JSON.parse(probe(candidate));
        if (receipt.implementation === "CPython" && receipt.version === expected.version
            && receipt.profile === expected.alias.slice(6) && typeof receipt.executable === "string"
            && receipt.executable.length > 0) {
          selection = { ...expected, executable: realpathSync(receipt.executable) };
          break;
        }
      } catch {}
    }
    if (!selection) throw new Error(`Broad QA requires evidence-bound ${expected.alias} ${expected.version} on macOS`);
    selections.push(selection);
  }
  return selections;
}

export function selectSupportedPython(options = {}) {
  return selectSupportedPythonProfiles(options)?.[0] ?? null;
}

export function qaHostEnvironment({ platform = process.platform,
  selections = selectSupportedPythonProfiles({ platform }),
  sdk = selectMacSdk({ platform }), baseEnvironment = process.env } = {}) {
  const environment = { ...baseEnvironment };
  let cleanup = () => {};
  if (platform === "darwin") {
    if (!Array.isArray(selections) || selections.length !== supportedPythonProfiles.length) {
      throw new Error("Broad QA evidence-bound Python selections are unavailable");
    }
    const shimRoot = mkdtempSync(join(tmpdir(), "job-apply-qa-python-"));
    for (const selection of selections) symlinkSync(selection.executable, join(shimRoot, selection.alias));
    symlinkSync(selections[0].executable, join(shimRoot, "python3"));
    environment.PATH = `${shimRoot}${delimiter}${environment.PATH ?? ""}`;
    environment.JOB_APPLY_CONTRACT_PYTHON = join(shimRoot, "python3");
    environment.PYTHON = join(shimRoot, "python3");
    if (!sdk?.path || !sdk?.compiler) throw new Error("Broad QA xcrun SDK selection is unavailable");
    environment.SDKROOT = sdk.path;
    environment.JOB_APPLY_QA_XCRUN_CLANG = sdk.compiler;
    cleanup = () => rmSync(shimRoot, { recursive: true, force: true });
  }
  return { environment, cleanup };
}

export function qaBrowserInvocation(options = {}) {
  const host = qaHostEnvironment(options);
  return {
    command: process.execPath,
    args: ["--test", "--test-concurrency=1", ...readdirSync(join(root, "tests_js"))
      .filter(name => name.endsWith(".test.mjs")).sort().map(name => join("tests_js", name))],
    options: { cwd: root, env: host.environment, stdio: "inherit", shell: false },
    cleanup: host.cleanup,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let invocation;
  try {
    invocation = qaBrowserInvocation();
    const result = spawnSync(invocation.command, invocation.args, invocation.options);
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    invocation?.cleanup();
  }
}
