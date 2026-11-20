import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const mainRef = "refs/remotes/origin/main";
const stableBranch = "refs/heads/stable";
const stableRef = "refs/remotes/origin/stable";
const candidateRef = "refs/job-apply/release-candidate";
const manifest = ".codex-plugin/plugin.json";
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { encoding: "utf8" });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw result.error ?? new Error(`Could not compare release ancestry: ${result.stderr}`);
}

function pluginVersion(sha) {
  const { version } = JSON.parse(git("show", `${sha}:${manifest}`));
  if (typeof version !== "string" || !versionPattern.test(version)) {
    throw new Error(`Invalid stable plugin version at ${sha}`);
  }
  return version;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  const index = leftParts.findIndex((value, part) => value !== rightParts[part]);
  if (index === -1) return 0;
  return leftParts[index] > rightParts[index] ? 1 : -1;
}

function stableOnRemote() {
  return git("ls-remote", "--refs", "origin", stableBranch).split("\t")[0];
}

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
}

function resolveCandidate(tag, expectedSha) {
  if (!tag?.startsWith("v") || !versionPattern.test(tag.slice(1))) {
    throw new Error("Stable release tags must use vX.Y.Z");
  }
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) {
    throw new Error("Expected a full release commit SHA");
  }
  git("fetch", "--no-tags", "origin", `+refs/heads/main:${mainRef}`, `+refs/tags/${tag}:${candidateRef}`);
  const sha = git("rev-parse", "--verify", `${candidateRef}^{commit}`);
  if (sha !== expectedSha) throw new Error("Release tag no longer matches the expected commit");
  if (!isAncestor(sha, mainRef)) throw new Error("Release commit is outside origin/main");
  if (pluginVersion(sha) !== tag.slice(1)) {
    throw new Error(`Release tag ${tag} does not match the Codex plugin version`);
  }
  return sha;
}

function promote(tag, sha) {
  const previous = stableOnRemote();
  output("previous_stable", previous);
  if (!previous) throw new Error("Seed stable at the current stable release before promoting");
  if (previous === sha) {
    output("outcome", "already-promoted");
    return;
  }

  git("fetch", "--no-tags", "origin", `+${stableBranch}:${stableRef}`);
  if (git("rev-parse", stableRef) !== previous) throw new Error("Stable advanced during promotion. Retry this release.");
  if (!isAncestor(previous, sha)) throw new Error("Stable can only advance by fast-forward");
  if (compareVersions(tag.slice(1), pluginVersion(previous)) <= 0) {
    throw new Error("Stable can only advance to a newer version");
  }

  git("push", "origin", `${sha}:${stableBranch}`);
  if (stableOnRemote() !== sha) throw new Error("Remote stable did not resolve to the promoted commit");
  output("outcome", "promoted");
}

try {
  const [mode, tag, expectedSha] = process.argv.slice(2);
  if (mode !== "admit" && mode !== "promote") throw new Error("Expected admit or promote");
  if (mode === "admit") output("previous_stable", stableOnRemote());
  const sha = resolveCandidate(tag, expectedSha);
  output("candidate_sha", sha);
  if (mode === "promote") promote(tag, sha);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
