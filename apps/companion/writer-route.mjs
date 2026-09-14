import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateNativeStoreMarker } from "../../runtime/store/native-store-layout.js";

const writers = new Set(["python", "native-fixture", "native-clone"]);
const valueOptions = new Set([
  "--root", "--plugin-root", "--port", "--writer", "--native-lock", "--native-jobs-fixture",
]);

export function parseWriterOptions(args, app) {
  const options = { root: undefined, pluginRoot: resolve(app, "../.."), port: 0, dev: false,
    writer: "python", nativeLock: undefined };
  const seen = new Set();
  let legacyNativeLock;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (seen.has(key)) throw new Error("Duplicate launcher option");
    seen.add(key);
    if (key === "--dev") { options.dev = true; continue; }
    if (!valueOptions.has(key)) throw new Error("Unknown launcher option");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("Missing launcher option value");
    if (key === "--root") options.root = resolve(value);
    if (key === "--plugin-root") options.pluginRoot = resolve(value);
    if (key === "--port") options.port = Number(value);
    if (key === "--writer") options.writer = value;
    if (key === "--native-lock") options.nativeLock = resolve(value);
    if (key === "--native-jobs-fixture") legacyNativeLock = resolve(value);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("Invalid port");
  }
  if (legacyNativeLock) {
    if (seen.has("--writer") || seen.has("--native-lock")) throw new Error("Conflicting writer options");
    options.writer = "native-fixture";
    options.nativeLock = legacyNativeLock;
  }
  if (!writers.has(options.writer)) throw new Error("Invalid writer");
  return options;
}

async function marker(root, name) {
  const path = join(root, name);
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Store writer marker is invalid");
  return validateNativeStoreMarker(name, await readFile(path));
}

export async function storeWriterOwnership(root) {
  if (!root) return null;
  const [fixture, clone] = await Promise.all([
    marker(root, ".native-jobs-fixture"), marker(root, ".native-store-clone"),
  ]);
  if (fixture && clone) throw new Error("Store has conflicting writer ownership");
  return fixture ?? clone;
}

export async function resolveWriterRoute(options) {
  const ownership = await storeWriterOwnership(options.root);
  if (options.writer === "python") {
    if (options.nativeLock) throw new Error("Python writer cannot use a native lock provider");
    if (ownership) throw new Error("Python writer cannot use a native-owned Store");
    const script = join(options.pluginRoot, "scripts/job-apply-workspace.py");
    if (!existsSync(script)) throw new Error("Workspace runtime is unavailable");
    return { writer: "python", command: "python3",
      argv: [script, "--no-open", "--json", ...(options.root ? ["--root", options.root] : [])] };
  }
  if (!options.root || !options.nativeLock) throw new Error("Native writer requires an explicit root and lock provider");
  const expected = options.writer === "native-clone" ? "clone" : "fixture";
  if (ownership !== expected) throw new Error(`Native ${expected} writer ownership is missing`);
  const script = join(options.pluginRoot, "runtime/cli/native-jobs-server.js");
  if (!existsSync(script) || !existsSync(options.nativeLock)) throw new Error("Workspace runtime is unavailable");
  return { writer: options.writer, command: process.execPath,
    argv: [script, "--root", options.root, "--native-lock", options.nativeLock] };
}
