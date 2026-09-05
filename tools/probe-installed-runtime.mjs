#!/usr/bin/env node
/** Value-free runtime candidate probe; it never selects a release launcher. */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

export const MINIMUM_NODE_MAJOR = 22;
export const PROBE_TIMEOUT_MS = 2_000;
const OUTPUT_LIMIT_BYTES = 256;
const PLATFORMS = new Set(["linux", "darwin", "win32"]);
const ARCHITECTURES = new Set(["x64", "arm64", "ia32", "arm"]);
const execute = promisify(execFile);

async function runVersion(command, args, options) {
  // A diagnostic must not execute user-supplied Node preload instructions.
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return execute(command, args, { ...options, env: environment });
}

function stableVersion(stdout) {
  if (typeof stdout !== "string" || stdout.length > OUTPUT_LIMIT_BYTES) return null;
  const match = /^v(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\r?\n?$/.exec(stdout);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export async function probeRuntime({
  runner = runVersion,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const receipt = {
    platform: PLATFORMS.has(platform) ? platform : "unknown",
    arch: ARCHITECTURES.has(arch) ? arch : "unknown",
    nodeAvailable: false,
    nodeVersion: null,
    launchMode: "unresolved",
  };
  try {
    const result = await runner("node", ["--version"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT_BYTES,
      windowsHide: true,
      shell: false,
    });
    const version = stableVersion(result?.stdout);
    if (version === null || (result.stderr !== undefined && result.stderr !== "")) return receipt;
    receipt.nodeAvailable = true;
    receipt.nodeVersion = version;
    if (Number(version.split(".")[0]) >= MINIMUM_NODE_MAJOR
        && receipt.platform !== "unknown" && receipt.arch !== "unknown") {
      receipt.launchMode = "node-candidate";
    }
  } catch {
    // Missing binaries, timeout, permission failures and diagnostics stay private.
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await probeRuntime()));
}
