import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const receiptKeys = ["arch", "artifactSha256", "nodeApiVersion", "platform", "schemaVersion", "sourceSha256"];
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function regular(path: string, label: string): Promise<Buffer> {
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`Packaged native lock ${label} is unavailable`);
  return readFile(path);
}

/** Select and verify an assembled host artifact. This never builds or downloads code. */
export async function resolvePackagedNativeLock(pluginRoot: string): Promise<string> {
  if (!isAbsolute(pluginRoot) || resolve(pluginRoot) !== pluginRoot
    || await realpath(pluginRoot).catch(() => null) !== pluginRoot) {
    throw new TypeError("Plugin root must be an absolute canonical directory");
  }
  const windows = process.platform === 'win32';
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || windows && process.arch !== 'x64') {
    throw new Error("Packaged native lock is unavailable on this platform");
  }
  const napi = Number(process.versions.napi);
  if (!Number.isInteger(napi) || napi < 8) throw new Error("Packaged native lock requires Node-API 8");
  const directory = join(pluginRoot, "native", "packaged-lock", `${process.platform}-${process.arch}-napi8`);
  if (await realpath(directory).catch(() => null) !== directory) throw new Error("Packaged native lock directory is unavailable");
  // The Windows receipt binds the addon source and the header it includes, as the build does.
  const sourcePaths = windows
    ? [join(pluginRoot, "native", "windows", "flock.c"), join(pluginRoot, "native", "windows", "store-metadata.h")]
    : [join(pluginRoot, "native", "posix", "flock.c")];
  for (const sourcePath of sourcePaths) {
    if (await realpath(sourcePath).catch(() => null) !== sourcePath) throw new Error("Packaged native lock source is unavailable");
  }
  const source = Buffer.concat(await Promise.all(sourcePaths.map(path => regular(path, "source"))));
  const artifactPath = join(directory, "flock.node");
  const [artifact, receiptBytes] = await Promise.all([
    regular(artifactPath, "artifact"), regular(join(directory, "receipt.json"), "receipt"),
  ]);
  let value: unknown;
  try { value = JSON.parse(receiptBytes.toString("utf8")); }
  catch { throw new Error("Packaged native lock receipt is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\n") !== receiptKeys.join("\n")) {
    throw new Error("Packaged native lock receipt is invalid");
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== 1 || receipt.platform !== process.platform || receipt.arch !== process.arch
    || receipt.nodeApiVersion !== 8 || receipt.sourceSha256 !== digest(source)
    || receipt.artifactSha256 !== digest(artifact)) {
    throw new Error("Packaged native lock receipt does not match this installation");
  }
  return artifactPath;
}
