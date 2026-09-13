import fs from "node:fs/promises";
import path from "node:path";
import { runCapture } from "./process.mjs";
import { normalizePath } from "./patterns.mjs";

function parseNameStatus(buffer) {
  const fields = buffer.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (/^[RC]/.test(status)) {
      paths.push(fields[index++], fields[index++]);
    } else {
      paths.push(fields[index++]);
    }
  }
  return paths.filter(Boolean).map(normalizePath);
}

async function git(root, args, allowFailure = false) {
  const result = await runCapture("git", args, { cwd: root });
  if (result.code !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result;
}

export async function resolveRevision(root, revision) {
  const result = await git(root, ["rev-parse", "--verify", `${revision}^{commit}`], true);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function defaultBase(root) {
  for (const candidate of ["origin/staging", "HEAD~1", "HEAD"]) {
    if (await resolveRevision(root, candidate)) return candidate;
  }
  return "HEAD";
}

export async function collectChanges(root, requestedBase) {
  const baseRef = requestedBase ?? await defaultBase(root);
  const baseSha = await resolveRevision(root, baseRef);
  if (!baseSha) throw new Error(`base revision does not exist: ${baseRef}`);
  const headSha = await resolveRevision(root, "HEAD");
  const mergeBase = (await git(root, ["merge-base", baseSha, headSha])).stdout.trim();
  const commands = [
    ["diff", "--name-status", "-z", mergeBase, headSha],
    ["diff", "--cached", "--name-status", "-z"],
    ["diff", "--name-status", "-z"],
  ];
  const changed = [];
  for (const args of commands) {
    const result = await git(root, args);
    changed.push(...parseNameStatus(result.stdout));
  }
  const untracked = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  changed.push(...untracked.stdout.split("\0").filter(Boolean).map(normalizePath));
  return {
    baseSha: mergeBase,
    headSha,
    changedPaths: [...new Set(changed)].sort(),
  };
}

export async function trackedPaths(root) {
  const result = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const candidates = result.stdout.split("\0").filter(Boolean).map(normalizePath);
  const present = await Promise.all(candidates.map(async (item) => {
    try {
      await fs.lstat(path.join(root, item));
      return item;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }));
  return present.filter(Boolean).sort();
}

export { parseNameStatus };
