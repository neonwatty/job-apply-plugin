import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../tools/ci/promote-release.mjs", import.meta.url));
const manifest = ".codex-plugin/plugin.json";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "job-apply-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  function git(...args) {
    return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("config", "user.name", "Release tester");
  git("config", "user.email", "release@example.test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", remote);
  mkdirSync(join(directory, ".codex-plugin"));

  function commit(version) {
    writeFileSync(join(directory, manifest), JSON.stringify({ version }));
    git("add", manifest);
    git("commit", "--allow-empty", "-m", version);
    return git("rev-parse", "HEAD");
  }

  function publish(tag, sha) {
    git("tag", "--no-sign", "-am", tag, tag, sha);
    git("push", "origin", `refs/tags/${tag}`);
  }

  function release(mode, tag, sha) {
    return spawnSync(process.execPath, [script, mode, tag, sha], {
      cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "" },
    });
  }

  const seed = commit("1.3.6");
  git("push", "origin", "main:main", `${seed}:refs/heads/stable`);
  return {
    git, commit, publish, release, seed,
    stable: () => git("ls-remote", "--refs", "origin", "refs/heads/stable").split("\t")[0],
  };
}

function failed(result, message) {
  assert.equal(result.status, 1);
  assert.match(result.stderr, message);
}

test("release admission pins the annotated tag and promotion is repeatable", t => {
  const repo = fixture(t);
  const candidate = repo.commit("1.3.7");
  repo.commit("1.3.8");
  repo.git("push", "origin", "main");
  repo.publish("v1.3.7", candidate);

  const admission = repo.release("admit", "v1.3.7", candidate);
  assert.equal(admission.status, 0, admission.stderr);
  assert.match(admission.stdout, new RegExp(`candidate_sha=${candidate}`));
  assert.equal(repo.stable(), repo.seed);

  const promotion = repo.release("promote", "v1.3.7", candidate);
  assert.equal(promotion.status, 0, promotion.stderr);
  assert.match(promotion.stdout, /outcome=promoted/);
  assert.equal(repo.stable(), candidate);

  const retry = repo.release("promote", "v1.3.7", candidate);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /outcome=already-promoted/);
  assert.equal(repo.stable(), candidate);
});

test("release admission rejects invalid candidates before stable changes", t => {
  const repo = fixture(t);
  const candidate = repo.commit("1.3.7");
  repo.git("push", "origin", "main");
  repo.publish("v1.3.8", candidate);
  failed(repo.release("admit", "v1.3.8", candidate), /does not match the Codex plugin version/);
  failed(repo.release("admit", "v1.3.8", repo.seed), /no longer matches/);
  failed(repo.release("admit", "v1.3.8-rc.1", candidate), /must use vX.Y.Z/);
  failed(repo.release("admit", "v1.03.8", candidate), /must use vX.Y.Z/);

  repo.git("switch", "-c", "other");
  const offMain = repo.commit("1.3.9");
  repo.publish("v1.3.9", offMain);
  failed(repo.release("admit", "v1.3.9", offMain), /outside origin\/main/);
  assert.equal(repo.stable(), repo.seed);
});

test("an older promotion cannot replace the current stable release", t => {
  const repo = fixture(t);
  const earlier = repo.commit("1.3.9");
  const later = repo.commit("1.3.10");
  const versionRegression = repo.commit("1.3.8");
  repo.git("push", "origin", "main");
  repo.publish("v1.3.9", earlier);
  repo.publish("v1.3.10", later);
  repo.publish("v1.3.8", versionRegression);

  assert.equal(repo.release("admit", "v1.3.9", earlier).status, 0);
  const promotion = repo.release("promote", "v1.3.10", later);
  assert.equal(promotion.status, 0, promotion.stderr);
  failed(repo.release("promote", "v1.3.9", earlier), /advance by fast-forward/);
  failed(repo.release("promote", "v1.3.8", versionRegression), /advance to a newer version/);
  assert.equal(repo.stable(), later);
});

test("promotion rechecks tag identity after validation and requires a seed", t => {
  const repo = fixture(t);
  const candidate = repo.commit("1.3.7");
  const replacement = repo.commit("1.3.7");
  repo.git("push", "origin", "main");
  repo.publish("v1.3.7", candidate);
  assert.equal(repo.release("admit", "v1.3.7", candidate).status, 0);

  repo.git("tag", "--no-sign", "-f", "v1.3.7", replacement);
  repo.git("push", "origin", "+refs/tags/v1.3.7");
  failed(repo.release("promote", "v1.3.7", candidate), /no longer matches/);
  assert.equal(repo.stable(), repo.seed);

  repo.git("push", "origin", ":refs/heads/stable");
  failed(repo.release("promote", "v1.3.7", replacement), /Seed stable/);
  assert.equal(repo.stable(), "");
});
