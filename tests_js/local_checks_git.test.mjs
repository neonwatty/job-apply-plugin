import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { git, indexSnapshot, pushTargets, resolveCommit, withSnapshot } from "../tools/local-checks/git.mjs";

const ZERO = "0".repeat(40);

function command(root, args, input) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", root, ...args], {
    encoding: "utf8", input, env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function fixture(t, initial = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "job-apply-local-checks-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  command(root, ["init", "-b", "main"]);
  command(root, ["config", "user.name", "Synthetic Hook Test"]);
  command(root, ["config", "user.email", "hook@example.invalid"]);
  if (initial) {
    await fs.writeFile(path.join(root, "value.txt"), "base\n");
    command(root, ["add", "."]);
    command(root, ["commit", "-m", "synthetic base"]);
  }
  return root;
}

async function commitValue(root, value) {
  await fs.writeFile(path.join(root, "value.txt"), `${value}\n`);
  command(root, ["add", "value.txt"]);
  command(root, ["commit", "-m", `synthetic ${value}`]);
  return command(root, ["rev-parse", "HEAD"]).trim();
}

function pushLine(localRef, localSha, remoteRef, remoteSha) {
  return `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;
}

test("Git helper preserves stdout and resolves only existing commits", async (t) => {
  const root = await fixture(t);
  assert.equal(await git(root, ["show", "HEAD:value.txt"]), "base\n");
  assert.equal(await resolveCommit(root, "HEAD"), command(root, ["rev-parse", "HEAD"]).trim());
  await assert.rejects(async () => resolveCommit(root, "refs/heads/missing"));
});

test("index snapshot isolates staged content and preserves dirty root/index", async (t) => {
  const root = await fixture(t);
  const head = command(root, ["rev-parse", "HEAD"]).trim();
  await fs.writeFile(path.join(root, "value.txt"), "staged\n");
  command(root, ["add", "value.txt"]);
  await fs.writeFile(path.join(root, "value.txt"), "unstaged\n");
  await fs.writeFile(path.join(root, "private-untracked.txt"), "untracked synthetic\n");
  const originalIndex = await fs.readFile(path.join(root, ".git", "index"));
  const snapshot = await indexSnapshot(root);
  assert.equal(snapshot.tree, command(root, ["rev-parse", `${snapshot.commit}^{tree}`]).trim());
  assert.equal(snapshot.base, head);
  assert.equal(command(root, ["show", `${snapshot.commit}:value.txt`]), "staged\n");
  let isolated;
  const returned = await withSnapshot(root, snapshot.commit, async (directory) => {
    isolated = directory;
    assert.notEqual(directory, root);
    assert.equal(await fs.readFile(path.join(directory, "value.txt"), "utf8"), "staged\n");
    await assert.rejects(fs.stat(path.join(directory, "private-untracked.txt")), { code: "ENOENT" });
    await fs.writeFile(path.join(directory, "value.txt"), "disposable mutation\n");
    return "callback result";
  });
  assert.equal(returned, "callback result");
  await assert.rejects(fs.stat(isolated), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(root, "value.txt"), "utf8"), "unstaged\n");
  assert.deepEqual(await fs.readFile(path.join(root, ".git", "index")), originalIndex);
  assert.equal(command(root, ["rev-parse", "HEAD"]).trim(), head);
});

test("unborn staged index and staged deletion/rename produce exact snapshots", async (t) => {
  const unborn = await fixture(t, false);
  await fs.writeFile(path.join(unborn, "first.txt"), "first staged\n");
  command(unborn, ["add", "first.txt"]);
  const first = await indexSnapshot(unborn);
  assert.equal(command(unborn, ["show", `${first.commit}:first.txt`]), "first staged\n");
  assert.equal(command(unborn, ["ls-tree", "--name-only", first.tree]), "first.txt\n");

  const root = await fixture(t);
  await fs.writeFile(path.join(root, "remove.txt"), "remove me\n");
  command(root, ["add", "."]);
  command(root, ["commit", "-m", "add removable fixture"]);
  command(root, ["mv", "value.txt", "renamed.txt"]);
  command(root, ["rm", "remove.txt"]);
  const snapshot = await indexSnapshot(root);
  assert.equal(command(root, ["ls-tree", "--name-only", snapshot.tree]), "renamed.txt\n");
  assert.equal(command(root, ["show", `${snapshot.commit}:renamed.txt`]), "base\n");
});

test("snapshot callback failure removes only owned worktree and preserves original state", async (t) => {
  const root = await fixture(t);
  const before = command(root, ["worktree", "list", "--porcelain"]);
  const snapshot = await indexSnapshot(root);
  let isolated;
  await assert.rejects(withSnapshot(root, snapshot.commit, async (directory) => {
    isolated = directory;
    await fs.writeFile(path.join(directory, "untracked.txt"), "disposable\n");
    throw new Error("synthetic callback failure");
  }), /synthetic callback failure/);
  await assert.rejects(fs.stat(isolated), { code: "ENOENT" });
  assert.equal(command(root, ["worktree", "list", "--porcelain"]), before);
  assert.equal(await fs.readFile(path.join(root, "value.txt"), "utf8"), "base\n");
});

test("hook alternate index is captured without leaking Git environment into snapshots", async (t) => {
  const root = await fixture(t);
  const originalIndex = await fs.readFile(path.join(root, ".git", "index"));
  await fs.writeFile(path.join(root, "value.txt"), "alternate staged\n");
  command(root, ["add", "value.txt"]);
  const alternate = path.join(root, ".git", "synthetic-alternate-index");
  await fs.copyFile(path.join(root, ".git", "index"), alternate);
  await fs.writeFile(path.join(root, ".git", "index"), originalIndex);
  const previous = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = alternate;
  try {
    const snapshot = await indexSnapshot(root);
    assert.equal(command(root, ["show", `${snapshot.commit}:value.txt`]), "alternate staged\n");
    await withSnapshot(root, snapshot.commit, async (directory) => {
      assert.equal(await fs.readFile(path.join(directory, "value.txt"), "utf8"), "alternate staged\n");
      assert.equal((await git(directory, ["show", ":value.txt"])), "alternate staged\n");
    });
    assert.deepEqual(await fs.readFile(path.join(root, ".git", "index")), originalIndex);
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
});

test("push targets use pushed commits, support multiple refs and ignore deletions", async (t) => {
  const root = await fixture(t);
  const base = command(root, ["rev-parse", "HEAD"]).trim();
  const pushed = await commitValue(root, "pushed");
  const current = await commitValue(root, "current");
  const input = pushLine("refs/heads/topic", pushed, "refs/heads/topic", base)
    + pushLine("refs/heads/other", current, "refs/heads/other", pushed)
    + pushLine("(delete)", ZERO, "refs/heads/removed", base);
  const targets = await pushTargets(root, input);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map(({ commit, base: prior }) => [commit, prior]), [[pushed, base], [current, pushed]]);
});

test("new branches use merge base with explicitly configured comparison ref", async (t) => {
  const root = await fixture(t);
  const common = command(root, ["rev-parse", "HEAD"]).trim();
  const pushed = await commitValue(root, "topic");
  command(root, ["checkout", "-b", "comparison", common]);
  const comparison = await commitValue(root, "comparison");
  command(root, ["update-ref", "refs/remotes/origin/staging", comparison]);
  const input = pushLine("refs/heads/topic", pushed, "refs/heads/topic", ZERO);
  const targets = await pushTargets(root, input, "refs/heads/comparison");
  assert.equal(targets[0].commit, pushed);
  assert.equal(targets[0].base, common);
  await assert.rejects(async () => pushTargets(root, input, "refs/heads/unavailable"));
});

test("push validation rejects malformed records and unavailable remote objects", async (t) => {
  const root = await fixture(t);
  const head = command(root, ["rev-parse", "HEAD"]).trim();
  for (const input of [
    "malformed\n",
    `refs/heads/main ${head} refs/heads/main\n`,
    `refs/heads/main ${head} refs/heads/main ${head} extra\n`,
    pushLine("refs/heads/main", "not-a-sha", "refs/heads/main", head),
    pushLine("refs/heads/main", head, "refs/heads/main", "f".repeat(40)),
  ]) await assert.rejects(async () => pushTargets(root, input));
});

test("annotated tag targets peel to the commit actually pushed", async (t) => {
  const root = await fixture(t);
  const base = command(root, ["rev-parse", "HEAD"]).trim();
  command(root, ["update-ref", "refs/remotes/origin/staging", base]);
  const tagged = await commitValue(root, "tagged");
  command(root, ["-c", "tag.gpgsign=false", "tag", "-a", "synthetic-v1", "-m", "synthetic tag"]);
  const tagObject = command(root, ["rev-parse", "refs/tags/synthetic-v1"]).trim();
  await commitValue(root, "later-head");
  const targets = await pushTargets(root, pushLine("refs/tags/synthetic-v1", tagObject, "refs/tags/synthetic-v1", ZERO));
  assert.equal(targets.length, 1);
  assert.equal(targets[0].commit, tagged);
  assert.equal(targets[0].base, base);
  assert.ok(targets[0].tag);
});
