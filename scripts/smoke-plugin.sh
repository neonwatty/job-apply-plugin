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
import hashlib
import re
import stat
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1])
sys.path.insert(0, str(root))

from qa.contracts import ContractError, validate_fixture
from qa.privacy import PrivacyError, scan_tree
from qa.promote import (
    APPROVAL_KEYS,
    PROVENANCE_KEYS,
    PromotionError,
    _timestamp,
    _validate_approval,
)

expected = {"answer-memory", "job-apply", "job-search", "job-preferences"}

launcher = root / "scripts" / "qa-chrome.py"
try:
    launcher_metadata = launcher.lstat()
except OSError as error:
    raise SystemExit("replay QA launcher is missing from the plugin source") from error
if not stat.S_ISREG(launcher_metadata.st_mode):
    raise SystemExit("replay QA launcher must be a regular file")

readme = (root / "README.md").read_text(encoding="utf-8")
profile = "linkedin-capture"
required_launcher_commands = (
    f"python3 scripts/qa-chrome.py start --profile {profile}",
    f"python3 scripts/qa-chrome.py check --profile {profile}",
    f"python3 scripts/qa-chrome.py stop --profile {profile}",
    f"python3 scripts/qa-chrome.py reset --profile {profile}",
)
for command in required_launcher_commands:
    if command not in readme:
        raise SystemExit("README is missing the complete replay QA launcher workflow")
if re.search(r"--remote-debugging-port(?:=|\s+)\d+", readme):
    raise SystemExit("README must not prescribe a fixed Chrome debugging port")
if re.search(r"(?m)^\s*open\b[^\n]*--remote-debugging-port", readme):
    raise SystemExit("README must not prescribe a direct open/remote-debugging recipe")
if "--confirm" in readme:
    raise SystemExit("README must not require typed confirmation for manual reset guidance")
if "~/.job-apply-qa/chrome-profiles/linkedin-capture" not in readme:
    raise SystemExit("README must document the literal dedicated manual-removal path")
if "requires no Trash permission" not in readme:
    raise SystemExit("README must document that reset does not require Trash access")


def git(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    try:
        return subprocess.run(
            ["git", "-C", str(root), *arguments],
            check=check,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise SystemExit("unable to inspect repository fixture policy") from error


private_ignore_probes = (
    ".qa-private/smoke-probe",
    ".qa-private/nested/private fixture.json",
    ".qa-private/nested/!approval.json",
    "qa/runs/smoke-probe",
    "qa/runs/nested/[private] report.json",
    "qa/runs/nested/provenance.json",
)
for ignored_path in private_ignore_probes:
    ignored = git("check-ignore", "--no-index", "-q", "--", ignored_path, check=False)
    if ignored.returncode != 0:
        raise SystemExit("private QA paths must remain ignored without exceptions")

fixture_ignore_probes = tuple(
    f"qa/fixtures/smoke-fixture-v1/{name}"
    for name in ("fixture.json", "approval.json", "provenance.json")
) + ("qa/fixtures/nested-smoke-v1/subdirectory/odd [name].json",)
for fixture_path in fixture_ignore_probes:
    fixture_ignore = git(
        "check-ignore", "--no-index", "-q", "--", fixture_path, check=False
    )
    if fixture_ignore.returncode not in (0, 1):
        raise SystemExit("unable to inspect repository fixture policy")
    if fixture_ignore.returncode == 0:
        raise SystemExit("qa/fixtures/ and its durable files must not be ignored")

tracked_output = git(
    "ls-files", "-s", "-z", "--", ".qa-private/**", "qa/runs/**", "qa/fixtures/**"
).stdout
if len(tracked_output) > 1024 * 1024:
    raise SystemExit("tracked QA fixture inventory is unexpectedly large")
try:
    tracked_entries = []
    for entry in tracked_output.split(b"\0"):
        if not entry:
            continue
        header, separator, raw_path = entry.partition(b"\t")
        mode, object_id, stage = header.split(b" ")
        if not separator or stage != b"0" or not object_id:
            raise ValueError
        tracked_entries.append((mode.decode("ascii"), raw_path.decode("utf-8")))
except (UnicodeDecodeError, ValueError) as error:
    raise SystemExit("tracked QA fixture path is not UTF-8") from error
if len(tracked_entries) > 2_000 or any(
    len(path) > 512 for _mode, path in tracked_entries
):
    raise SystemExit("tracked QA fixture inventory exceeds safety limits")

private_tracked = [
    path
    for _mode, path in tracked_entries
    if path.startswith(".qa-private/") or path.startswith("qa/runs/")
]
if private_tracked:
    raise SystemExit(
        f"private QA artifact is tracked: {json.dumps(private_tracked[0])}"
    )

allowed_fixture_files = {"approval.json", "fixture.json", "provenance.json"}
fixture_id_pattern = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$")
fixture_inventory: dict[str, set[str]] = {}
for mode, path in tracked_entries:
    if not path.startswith("qa/fixtures/"):
        continue
    if mode != "100644":
        raise SystemExit("tracked fixture artifacts must be regular non-executable blobs")
    if path == "qa/fixtures/.gitkeep":
        continue
    parts = path.split("/")
    if len(parts) != 4 or parts[3] not in allowed_fixture_files:
        raise SystemExit(
            f"fixture contains a non-durable path: {json.dumps(path)}"
        )
    if fixture_id_pattern.fullmatch(parts[2]) is None:
        raise SystemExit("tracked fixture has an invalid identifier")
    fixture_inventory.setdefault(parts[2], set()).add(parts[3])
for fixture_id, files in fixture_inventory.items():
    if files != allowed_fixture_files:
        missing = sorted(allowed_fixture_files - files)
        raise SystemExit(f"fixture {fixture_id} is incomplete; missing {missing}")
    fixture_root = root / "qa" / "fixtures" / fixture_id
    try:
        for name in allowed_fixture_files:
            metadata = (fixture_root / name).lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024 * 1024:
                raise ValueError
        documents = {
            name: json.loads((fixture_root / name).read_text(encoding="utf-8"))
            for name in allowed_fixture_files
        }
        fixture_bytes = (fixture_root / "fixture.json").read_bytes()
        digest = hashlib.sha256(fixture_bytes).hexdigest()
        fixture = documents["fixture.json"]
        approval = documents["approval.json"]
        provenance = documents["provenance.json"]
        validate_fixture(fixture)
        _validate_approval(approval, digest)
        if (
            not isinstance(approval, dict)
            or set(approval) != APPROVAL_KEYS
            or not isinstance(provenance, dict)
            or set(provenance) != PROVENANCE_KEYS
            or fixture.get("id") != fixture_id
            or provenance.get("fixtureId") != fixture_id
            or provenance.get("fixtureSha256") != digest
            or provenance.get("schemaVersion") != approval.get("schemaVersion")
            or provenance.get("platformFamily") != fixture.get("platformFamily")
            or provenance.get("captureMonth") != fixture.get("captureMonth")
            or provenance.get("recorderVersion")
            != fixture.get("provenance", {}).get("recorderVersion")
            or provenance.get("sourceRecordingSha256")
            != fixture.get("provenance", {}).get("sourceRecordingSha256")
            or provenance.get("compilerVersion") != approval.get("compilerVersion")
            or provenance.get("scannerVersion") != approval.get("scannerVersion")
            or provenance.get("approvedBy") != approval.get("reviewer")
            or provenance.get("approvedAt") != approval.get("approvedAt")
        ):
            raise ValueError
        _timestamp(provenance.get("promotedAt"))
        scan_tree(fixture_root, [])
    except (
        ContractError,
        OSError,
        PrivacyError,
        PromotionError,
        RecursionError,
        UnicodeError,
        ValueError,
        json.JSONDecodeError,
    ) as error:
        raise SystemExit(f"fixture {fixture_id} failed durable validation") from error

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

print("Static smoke assertions passed")
PY

python3 "$REPO_ROOT/scripts/check-final-action-docs.py" \
  "$REPO_ROOT/skills/job-apply/SKILL.md"

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

python3 - "$SMOKE_FIXTURE_DIR" <<'PY'
import os
import stat
import sys
from pathlib import Path

fixture = Path(sys.argv[1])
excluded = (
    ".git",
    ".qa-private",
    "qa/runs",
    ".job-apply-qa",
    "node_modules",
    "coverage",
    "dist",
    "build",
    ".worktrees",
    "docs/goals",
    "test_resumes",
)
for relative in excluded:
    try:
        os.lstat(fixture / relative)
    except FileNotFoundError:
        continue
    except OSError as error:
        raise SystemExit("unable to verify packaged fixture exclusions") from error
    raise SystemExit("packaged fixture contains an excluded private or generated path")
launcher = fixture / "scripts" / "qa-chrome.py"
try:
    metadata = launcher.lstat()
except OSError as error:
    raise SystemExit("packaged fixture is missing the replay QA launcher") from error
if not os.path.isfile(launcher) or not stat.S_ISREG(metadata.st_mode):
    raise SystemExit("packaged replay QA launcher must be a regular file")
for generated in fixture.rglob("*"):
    if generated.name == "__pycache__" or generated.suffix in {".pyc", ".pyo"}:
        raise SystemExit("packaged fixture contains generated Python content")
print("Packaged fixture exclusions passed")
PY

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
