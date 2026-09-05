#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/job-apply-smoke.XXXXXX")"
SMOKE_CLAUDE_CONFIG_DIR="$SMOKE_TEMP_ROOT/claude-config"
SMOKE_CODEX_HOME="$SMOKE_TEMP_ROOT/codex-home"
SMOKE_CODEX_UPGRADE_HOME="$SMOKE_TEMP_ROOT/codex-upgrade-home"
SMOKE_FIXTURE_DIR="$SMOKE_TEMP_ROOT/plugin-fixture"
SMOKE_UPGRADE_FIXTURE_DIR="$SMOKE_TEMP_ROOT/plugin-upgrade-fixture"

cleanup() {
  rm -rf -- "$SMOKE_TEMP_ROOT"
}
trap cleanup EXIT

mkdir -p \
  "$SMOKE_CLAUDE_CONFIG_DIR" \
  "$SMOKE_CODEX_HOME" \
  "$SMOKE_CODEX_UPGRADE_HOME" \
  "$SMOKE_FIXTURE_DIR" \
  "$SMOKE_UPGRADE_FIXTURE_DIR"

echo "Validating plugin manifest"
claude plugin validate "$REPO_ROOT"
echo "Checking Store CLI entry point"
python3 "$REPO_ROOT/scripts/job-apply-store.py" --help >/dev/null
echo "Checking task CLI entry point"
python3 "$REPO_ROOT/scripts/job-apply-task.py" --help >/dev/null
echo "Checking attempt CLI entry point"
python3 "$REPO_ROOT/scripts/job-apply-attempt.py" --help >/dev/null
echo "Running unified task spine oracle"
node "$REPO_ROOT/qa/unified_task_spine_oracle.mjs" --json

python3 "$REPO_ROOT/scripts/smoke/store_lifecycle.py" "$REPO_ROOT" "$SMOKE_TEMP_ROOT"
python3 "$REPO_ROOT/scripts/smoke/repository_contracts.py" "$REPO_ROOT" "$SMOKE_TEMP_ROOT"
python3 "$REPO_ROOT/scripts/check-final-action-docs.py" "$REPO_ROOT/skills/job-apply/SKILL.md"

echo "Creating isolated working-tree marketplace fixture"
tar --exclude='./.git' \
  --exclude='./.qa-private' \
  --exclude='./qa/runs' \
  --exclude='./.job-apply-qa' \
  --exclude='./node_modules' \
  --exclude='./coverage' \
  --exclude='./dist' \
  --exclude='./build' \
  --exclude='__pycache__' \
  --exclude='*.py[co]' \
  --exclude='./.worktrees' \
  --exclude='./docs/goals' \
  --exclude='./test_resumes' \
  -cf - -C "$REPO_ROOT" . \
  | tar -xf - -C "$SMOKE_FIXTURE_DIR"
python3 "$REPO_ROOT/scripts/smoke/fixture_build.py" verify "$SMOKE_FIXTURE_DIR"

echo "Creating isolated prior-version Codex upgrade fixture"
cp -R "$SMOKE_FIXTURE_DIR/." "$SMOKE_UPGRADE_FIXTURE_DIR"
python3 "$REPO_ROOT/scripts/smoke/fixture_build.py" prepare-prior "$SMOKE_UPGRADE_FIXTURE_DIR"
CODEX_HOME="$SMOKE_CODEX_UPGRADE_HOME" codex plugin marketplace add \
  "$SMOKE_UPGRADE_FIXTURE_DIR" --json > "$SMOKE_TEMP_ROOT/codex-upgrade-marketplace-add.json"
CODEX_HOME="$SMOKE_CODEX_UPGRADE_HOME" codex plugin add job-apply@neonwatty-plugins \
  --json > "$SMOKE_TEMP_ROOT/codex-upgrade-old-plugin-add.json"
python3 "$REPO_ROOT/scripts/smoke/upgrade_verify.py" prior "$SMOKE_CODEX_UPGRADE_HOME"
python3 "$REPO_ROOT/scripts/smoke/fixture_build.py" copy-critical \
  "$SMOKE_FIXTURE_DIR" "$SMOKE_UPGRADE_FIXTURE_DIR"
CODEX_HOME="$SMOKE_CODEX_UPGRADE_HOME" codex plugin add job-apply@neonwatty-plugins \
  --json > "$SMOKE_TEMP_ROOT/codex-upgrade-new-plugin-add.json"
CODEX_HOME="$SMOKE_CODEX_UPGRADE_HOME" codex plugin list --json \
  > "$SMOKE_TEMP_ROOT/codex-upgrade-plugin-list.json"
python3 "$REPO_ROOT/scripts/smoke/upgrade_verify.py" upgrade \
  "$SMOKE_TEMP_ROOT/codex-upgrade-plugin-list.json" "$SMOKE_CODEX_UPGRADE_HOME" \
  "$SMOKE_FIXTURE_DIR"

python3 "$REPO_ROOT/scripts/smoke/workspace_verify.py" "$SMOKE_FIXTURE_DIR" "$SMOKE_TEMP_ROOT"
echo "Running Playwright and CLI walkthrough against packaged fixture"
JOB_WORKSPACE_TEST_ROOT="$SMOKE_FIXTURE_DIR" node --test \
  --test-name-pattern='owner beta clean packaged|real browser and CLI share CRUD|Needs Attention browser and CLI walkthrough' \
  "$REPO_ROOT/tests_js/workspace.test.mjs"
echo "Packaged Playwright and CLI walkthrough, including Needs Attention and unified Trash, passed"

python3 "$REPO_ROOT/scripts/smoke/fixture_build.py" rewrite-marketplace \
  "$SMOKE_FIXTURE_DIR/.claude-plugin/marketplace.json"
echo "Installing fixture with isolated CLAUDE_CONFIG_DIR=$SMOKE_CLAUDE_CONFIG_DIR"
CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" claude plugin marketplace add "$SMOKE_FIXTURE_DIR"
CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" claude plugin install job-apply@neonwatty-plugins
CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" claude plugin details \
  job-apply@neonwatty-plugins | tee "$SMOKE_TEMP_ROOT/plugin-details.txt"
for skill in answer-memory job-apply job-search job-preferences job-workspace; do
  if ! grep -Fq -- "$skill" "$SMOKE_TEMP_ROOT/plugin-details.txt"; then
    echo "Installed plugin details did not list $skill" >&2
    exit 1
  fi
done
CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" claude plugin list --json \
  > "$SMOKE_TEMP_ROOT/plugin-list.json"
python3 "$REPO_ROOT/scripts/smoke/plugin_install_verify.py" claude \
  "$SMOKE_TEMP_ROOT/plugin-list.json"

echo "Installing fixture with isolated CODEX_HOME=$SMOKE_CODEX_HOME"
CODEX_HOME="$SMOKE_CODEX_HOME" codex plugin marketplace add "$SMOKE_FIXTURE_DIR" \
  --json > "$SMOKE_TEMP_ROOT/codex-marketplace-add.json"
CODEX_HOME="$SMOKE_CODEX_HOME" codex plugin add job-apply@neonwatty-plugins \
  --json > "$SMOKE_TEMP_ROOT/codex-plugin-add.json"
CODEX_HOME="$SMOKE_CODEX_HOME" codex plugin list --json \
  > "$SMOKE_TEMP_ROOT/codex-plugin-list.json"
python3 "$REPO_ROOT/scripts/smoke/plugin_install_verify.py" codex \
  "$SMOKE_TEMP_ROOT/codex-plugin-list.json" "$SMOKE_CODEX_HOME" "$SMOKE_FIXTURE_DIR"

echo "Plugin smoke checks passed"
