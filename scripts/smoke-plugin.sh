#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/job-apply-smoke.XXXXXX")"
SMOKE_CLAUDE_CONFIG_DIR="$SMOKE_TEMP_ROOT/claude-config"
SMOKE_CODEX_HOME="$SMOKE_TEMP_ROOT/codex-home"
SMOKE_FIXTURE_DIR="$SMOKE_TEMP_ROOT/plugin-fixture"

cleanup() {
  rm -rf -- "$SMOKE_TEMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$SMOKE_CLAUDE_CONFIG_DIR" "$SMOKE_CODEX_HOME" "$SMOKE_FIXTURE_DIR"

echo "Validating plugin manifest"
claude plugin validate "$REPO_ROOT"

python3 "$REPO_ROOT/scripts/job-apply-store.py" --help >/dev/null

python3 - "$REPO_ROOT" <<'PY'
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
expected = {"answer-memory", "job-apply", "job-search", "job-preferences"}

for relative in (".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"):
    data = json.loads((root / relative).read_text())
    if "version" in data:
        raise SystemExit(f"{relative} must omit version for commit-resolved updates")
    for plugin in data.get("plugins", []):
        if "version" in plugin:
            raise SystemExit(f"{relative} plugin entries must omit version")

codex_manifest = json.loads((root / ".codex-plugin/plugin.json").read_text())
if codex_manifest.get("name") != "job-apply":
    raise SystemExit(".codex-plugin/plugin.json name must be job-apply")
if not re.fullmatch(r"\d+\.\d+\.\d+", codex_manifest.get("version", "")):
    raise SystemExit(".codex-plugin/plugin.json version must be strict SemVer")
if codex_manifest.get("skills") != "./skills/":
    raise SystemExit(".codex-plugin/plugin.json must expose ./skills/")
if codex_manifest.get("interface", {}).get("displayName") != "Job Apply":
    raise SystemExit(".codex-plugin/plugin.json is missing install-surface metadata")

codex_marketplace = json.loads((root / ".agents/plugins/marketplace.json").read_text())
codex_entries = codex_marketplace.get("plugins", [])
if len(codex_entries) != 1 or codex_entries[0].get("name") != "job-apply":
    raise SystemExit("Codex marketplace must expose exactly the job-apply plugin")
if codex_entries[0].get("source") != {"source": "local", "path": "./"}:
    raise SystemExit("Codex marketplace must point at the repository-root plugin")

skill_dirs = {path.name for path in (root / "skills").iterdir() if path.is_dir()}
if skill_dirs != expected:
    raise SystemExit(f"skill directories differ: expected {sorted(expected)}, got {sorted(skill_dirs)}")

for skill in expected:
    content = (root / "skills" / skill / "SKILL.md").read_text()
    match = re.search(r"(?m)^name:\s*([^\s]+)\s*$", content)
    if not match or match.group(1) != skill:
        raise SystemExit(f"skills/{skill}/SKILL.md frontmatter name is missing or incorrect")

invocation_pattern = re.compile(r"(?:\$|/)?job-apply:(answer-memory|job-apply|job-search|job-preferences)")
for relative in ("README.md", "site/index.html"):
    found = set(invocation_pattern.findall((root / relative).read_text()))
    if found != expected:
        raise SystemExit(f"{relative} inventory differs: expected {sorted(expected)}, got {sorted(found)}")

application_skill = (root / "skills/job-apply/SKILL.md").read_text()
answer_memory_skill = (root / "skills/answer-memory/SKILL.md").read_text()
for skill in expected:
    content = (root / "skills" / skill / "SKILL.md").read_text()
    if "job-apply-store.py" not in content:
        raise SystemExit(f"skills/{skill}/SKILL.md does not use the shared storage helper")
for required_root_contract in (
    "<plugin-root>/scripts/job-apply-store.py",
    "PLUGIN_ROOT",
    "CLAUDE_PLUGIN_ROOT",
):
    if required_root_contract not in answer_memory_skill:
        raise SystemExit(f"answer-memory skill is missing cross-host root contract: {required_root_contract}")
if "--remember-sensitive" not in answer_memory_skill:
    raise SystemExit("answer-memory skill is missing explicit sensitive remember consent")
if "Permission to fill is not permission to remember" not in answer_memory_skill:
    raise SystemExit("answer-memory skill does not separate fill consent from storage consent")
required_contract = (
    "User confirmation never authorizes this skill to click Submit, Send, "
    "or any equivalent final-action button."
)
if required_contract not in application_skill:
    raise SystemExit("hard manual-submit contract is missing")

safety_words = re.compile(
    r"\b(never|not|do not|don't|stop|before|manual(?:ly)?|untouched|leaves?)\b",
    re.IGNORECASE,
)
final_action = re.compile(r"\b(submit|send)\b", re.IGNORECASE)
for number, line in enumerate(application_skill.splitlines(), 1):
    if final_action.search(line) and not safety_words.search(line):
        raise SystemExit(f"unsafe final-action instruction at skills/job-apply/SKILL.md:{number}: {line}")

print("Static smoke assertions passed")
PY

echo "Creating isolated working-tree marketplace fixture"
tar --exclude='./.git' --exclude='./docs/goals' --exclude='./test_resumes' -cf - -C "$REPO_ROOT" . \
  | tar -xf - -C "$SMOKE_FIXTURE_DIR"

python3 - "$SMOKE_FIXTURE_DIR/.claude-plugin/marketplace.json" <<'PY'
import json
import sys
from pathlib import Path

manifest = Path(sys.argv[1])
data = json.loads(manifest.read_text())
data["plugins"][0]["source"] = "./"
manifest.write_text(json.dumps(data, indent=2) + "\n")
PY

echo "Installing fixture with isolated CLAUDE_CONFIG_DIR=$SMOKE_CLAUDE_CONFIG_DIR"
CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" claude plugin marketplace add "$SMOKE_FIXTURE_DIR"
CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" claude plugin install job-apply@neonwatty-plugins
CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" claude plugin details job-apply@neonwatty-plugins \
  | tee "$SMOKE_TEMP_ROOT/plugin-details.txt"

for skill in answer-memory job-apply job-search job-preferences; do
  if ! grep -Fq -- "$skill" "$SMOKE_TEMP_ROOT/plugin-details.txt"; then
    echo "Installed plugin details did not list $skill" >&2
    exit 1
  fi
done

CLAUDE_CONFIG_DIR="$SMOKE_CLAUDE_CONFIG_DIR" claude plugin list --json \
  > "$SMOKE_TEMP_ROOT/plugin-list.json"
python3 - "$SMOKE_TEMP_ROOT/plugin-list.json" <<'PY'
import json
import sys

plugins = json.load(open(sys.argv[1]))
serialized = json.dumps(plugins)
if "job-apply@neonwatty-plugins" not in serialized:
    raise SystemExit("isolated plugin list does not contain job-apply@neonwatty-plugins")
print("Isolated Claude Code marketplace install passed")
PY

echo "Installing fixture with isolated CODEX_HOME=$SMOKE_CODEX_HOME"
CODEX_HOME="$SMOKE_CODEX_HOME" codex plugin marketplace add "$SMOKE_FIXTURE_DIR" --json \
  > "$SMOKE_TEMP_ROOT/codex-marketplace-add.json"
CODEX_HOME="$SMOKE_CODEX_HOME" codex plugin add job-apply@neonwatty-plugins --json \
  > "$SMOKE_TEMP_ROOT/codex-plugin-add.json"
CODEX_HOME="$SMOKE_CODEX_HOME" codex plugin list --json \
  > "$SMOKE_TEMP_ROOT/codex-plugin-list.json"

python3 - "$SMOKE_TEMP_ROOT/codex-plugin-list.json" "$SMOKE_CODEX_HOME" <<'PY'
import json
import sys
from pathlib import Path

plugins = json.load(open(sys.argv[1]))
installed = plugins.get("installed", [])
match = next(
    (plugin for plugin in installed if plugin.get("pluginId") == "job-apply@neonwatty-plugins"),
    None,
)
if not match or not match.get("enabled"):
    raise SystemExit("isolated Codex plugin list does not contain an enabled job-apply plugin")

cache_root = Path(sys.argv[2]) / "plugins" / "cache" / "neonwatty-plugins" / "job-apply"
versions = [path for path in cache_root.iterdir() if path.is_dir()]
if len(versions) != 1:
    raise SystemExit(f"expected one isolated Codex plugin version, found {len(versions)}")

expected = {"answer-memory", "job-apply", "job-search", "job-preferences"}
installed_skills = {
    path.name for path in (versions[0] / "skills").iterdir() if path.is_dir()
}
if installed_skills != expected:
    raise SystemExit(
        f"installed Codex skill inventory differs: expected {sorted(expected)}, "
        f"got {sorted(installed_skills)}"
    )

print("Isolated Codex marketplace install passed")
PY

echo "Plugin smoke checks passed"
