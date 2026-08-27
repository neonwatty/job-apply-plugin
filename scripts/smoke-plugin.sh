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

python3 - "$REPO_ROOT" "$SMOKE_TEMP_ROOT" <<'PY'
import json
import hashlib
import importlib.util
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1])
smoke_root = Path(sys.argv[2])
sys.path.insert(0, str(root))

legacy_home = smoke_root / "legacy-home"
legacy_reports = legacy_home / ".claude-job-searches"
legacy_reports.mkdir(parents=True)
(legacy_reports / "search-smoke.md").write_text(
    """# Job Search Results — 2026-08-24
## Results (ranked by score)
### 1. Smoke Engineer — Example Co (Score: 90)
- **Source**: Example
- **URL**: https://example.com/jobs/smoke
""",
    encoding="utf-8",
)
legacy_store = smoke_root / "legacy-store"
legacy_environment = {**os.environ, "HOME": str(legacy_home)}
legacy_base = [
    sys.executable,
    str(root / "scripts" / "job-apply-store.py"),
    "--root",
    str(legacy_store),
]
discovery = json.loads(subprocess.run(
    [*legacy_base, "legacy-jobs-preview"], check=True, capture_output=True,
    text=True, env=legacy_environment,
).stdout)
if legacy_store.exists() or len(discovery.get("items", [])) != 1 or "token" in discovery:
    raise SystemExit("legacy migration discovery must be non-mutating and token-free")
item_id = discovery["items"][0]["itemId"]
preview = json.loads(subprocess.run(
    [*legacy_base, "legacy-jobs-preview", "--select", item_id], check=True,
    capture_output=True, text=True, env=legacy_environment,
).stdout)
commit = json.loads(subprocess.run(
    [*legacy_base, "legacy-jobs-commit", "--select", item_id, "--confirm", preview["token"]],
    check=True, capture_output=True, text=True, env=legacy_environment,
).stdout)
if not commit.get("committed") or commit.get("summary", {}).get("create") != 1:
    raise SystemExit("legacy migration selected commit smoke failed")

answer_store = smoke_root / "answers-store"
answer_base = [sys.executable, str(root / "scripts" / "job-apply-store.py"), "--root", str(answer_store)]
def answer_command(command, payload=None, *arguments):
    input_path = smoke_root / f"answer-{command}.json"
    final = [*answer_base, command, *arguments]
    if payload is not None:
        input_path.write_text(json.dumps(payload), encoding="utf-8")
        final.extend(["--input", str(input_path)])
    return json.loads(subprocess.run(final, check=True, capture_output=True, text=True).stdout)

observed = answer_command("answer-observe", {"question": "Smoke observed question?", "state": "missing", "scope": {"ats": "smoke"}})
concurrent_input = smoke_root / "answer-observe-concurrent.json"
concurrent_input.write_text(json.dumps({"question": "Smoke observed question!", "state": "missing", "scope": {"ats": "smoke"}}), encoding="utf-8")
processes = [subprocess.Popen(
    [*answer_base, "answer-observe", "--input", str(concurrent_input)],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
) for _ in range(8)]
concurrent_results = []
for process in processes:
    stdout, stderr = process.communicate()
    if process.returncode != 0:
        raise SystemExit(f"packaged concurrent answer observation failed: {stderr}")
    concurrent_results.append(json.loads(stdout))
observed = answer_command("answer-get", None, "--key", observed["key"])
if observed.get("observationCount") != 9 or len({item["revision"] for item in concurrent_results}) != 8:
    raise SystemExit("packaged concurrent answer observations were not additive")
accepted = answer_command("answer-review", {"value": "Reusable", "state": "confirmed"}, "--key", observed["key"], "--decision", "accepted", "--expected-revision", str(observed["revision"]))
sensitive = answer_command("answer-put", {"question": "Smoke sensitive question?", "state": "sensitive", "value": "private-smoke-answer", "sensitivity": "high"}, "--remember-sensitive")
library = answer_command("answer-list")
detail = answer_command("answer-get", None, "--key", sensitive["key"])
found = answer_command("answer-find", None, "--question", "Smoke sensitive question?", "--scope", "{}")
if library.get("total") != 2 or any("private-smoke-answer" in json.dumps(result) for result in (sensitive, library, detail, found)):
    raise SystemExit("packaged answer aggregate redaction failed")
declined = answer_command("answer-observe", {"question": "Smoke declined lookup?", "state": "missing"})
answer_command("answer-review", None, "--key", declined["key"], "--decision", "declined", "--expected-revision", str(declined["revision"]))
if answer_command("answer-find", None, "--question", "Smoke declined lookup?", "--scope", "{}") is not None:
    raise SystemExit("packaged default answer lookup reused a declined record")
revealed = answer_command("answer-reveal", None, "--key", sensitive["key"])
if revealed.get("value") != "private-smoke-answer":
    raise SystemExit("packaged explicit sensitive reveal failed")
history = answer_command("history-append", {"applicationId": "answer-smoke", "event": "reviewed", "answerKeys": [accepted["key"]]})
trashed = answer_command("answer-trash", None, "--key", accepted["key"], "--expected-revision", str(accepted["revision"]))
trash_page = answer_command("answer-list", None, "--all-review-statuses", "--include-trashed", "--trashed-only", "--offset", "0", "--limit", "1")
if trash_page.get("total") != 1 or trash_page.get("items", [{}])[0].get("key") != accepted["key"]:
    raise SystemExit("packaged answer trash filtering or pagination failed")
blocked = subprocess.run([*answer_base, "answer-delete", "--key", accepted["key"], "--expected-revision", str(trashed["revision"])], capture_output=True, text=True)
if blocked.returncode == 0 or "application history" not in blocked.stderr or "Reusable" in blocked.stderr:
    raise SystemExit("packaged history-guarded answer deletion failed")

attention_store = smoke_root / "attention-store"
attention_base = [sys.executable, str(root / "scripts" / "job-apply-store.py"), "--root", str(attention_store)]
attention_counter = 0
def attention_command(command, payload=None, *arguments):
    global attention_counter
    final = [*attention_base, command, *arguments]
    if payload is not None:
        input_path = smoke_root / f"attention-{attention_counter}.json"
        attention_counter += 1
        input_path.write_text(json.dumps(payload), encoding="utf-8")
        final.extend(["--input", str(input_path)])
    return json.loads(subprocess.run(final, check=True, capture_output=True, text=True).stdout)

attention_command("profile-replace", {"firstName": "Ada"}, "--expected-revision", "0", "--source", "user")
attention_resume = smoke_root / "attention-resume.pdf"
attention_resume.write_bytes(b"%PDF-1.7\nattention smoke")
attention_command("resume-create", {"id": "attention-resume", "label": "Attention", "path": str(attention_resume)})
def attention_ready(job_id, priority):
    created = attention_command("job-create", {"id": job_id, "url": f"https://example.com/jobs/{job_id}", "role": job_id, "company": "Smoke Co", "priority": priority})
    return attention_command("job-transition", None, "--id", job_id, "--status", "ready", "--expected-revision", str(created["revision"]))

review = attention_ready("review-smoke", 5)
review_claim = attention_command("job-acquire", None, "--id", review["id"], "--owner", "private-review-owner", "--expected-revision", str(review["revision"]))
review = attention_command("claim-handoff", {"status": "review", "step": "review", "pendingFields": []}, "--id", review["id"], "--token", review_claim["token"], "--status", "awaiting_review", "--expected-revision", str(review_claim["job"]["revision"]))["job"]
needs = attention_ready("needs-smoke", 4)
needs_claim = attention_command("job-acquire", None, "--id", needs["id"], "--owner", "private-needs-owner", "--expected-revision", str(needs["revision"]))
needs = attention_command("claim-handoff", {"status": "active", "step": "questions", "answerKeys": ["private.answer.key"], "pendingFields": [{"question": "Private question?", "state": "missing", "answerKey": "private.answer.key", "sensitive": True}]}, "--id", needs["id"], "--token", needs_claim["token"], "--status", "needs_info", "--expected-revision", str(needs_claim["job"]["revision"]))["job"]
interrupted = attention_ready("interrupted-smoke", 3)
interrupted_claim = attention_command("job-acquire", None, "--id", interrupted["id"], "--owner", "private-interrupted-owner", "--expected-revision", str(interrupted["revision"]))
interrupted = interrupted_claim["job"]
coordinator_path = attention_store / "coordinator.json"
coordinator_path.write_text(json.dumps({"schemaVersion": 1, "claim": None}), encoding="utf-8")
expired = attention_ready("expired-smoke", 1)
expired_claim = attention_command("job-acquire", None, "--id", expired["id"], "--owner", "private-expired-owner", "--expected-revision", str(expired["revision"]))
coordinator = json.loads(coordinator_path.read_text(encoding="utf-8"))
coordinator["claim"]["expiresAt"] = "2000-01-01T00:00:00Z"
coordinator_path.write_text(json.dumps(coordinator), encoding="utf-8")

store_spec = importlib.util.spec_from_file_location("smoke_job_apply_store", root / "scripts" / "job-apply-store.py")
store_module = importlib.util.module_from_spec(store_spec)
store_spec.loader.exec_module(store_module)
attention_projection = store_module.Store(attention_store).list_needs_attention()
if [item["reasonCode"] for item in attention_projection["items"]] != ["expired_agent_attempt", "claimless_interrupted_attempt", "awaiting_human_review", "needs_information"]:
    raise SystemExit("packaged Needs Attention taxonomy or ordering failed")
attention_serialized = json.dumps(attention_projection)
for forbidden in (expired_claim["token"], "private-expired-owner", "Private question?", "private.answer.key", "claimId", "ownerLabel", "answerKey", "sensitive", "operationId"):
    if forbidden in attention_serialized:
        raise SystemExit("packaged Needs Attention projection leaked private coordinator or answer data")
recovered = attention_command("claim-recover", None, "--id", expired["id"], "--owner", "replacement-owner")
interrupted = attention_command("job-transition", None, "--id", interrupted["id"], "--status", "needs_info", "--expected-revision", str(interrupted["revision"]))
attention_command("job-transition", None, "--id", interrupted["id"], "--status", "saved", "--expected-revision", str(interrupted["revision"]))
attention_command("job-transition", None, "--id", needs["id"], "--status", "saved", "--expected-revision", str(needs["revision"]))
attention_command("job-transition", None, "--id", review["id"], "--status", "applied", "--expected-revision", str(review["revision"]), "--user-confirmed")
if store_module.Store(attention_store).list_needs_attention()["items"]:
    raise SystemExit("packaged Needs Attention resolutions did not converge to empty")
if recovered["job"]["id"] != expired["id"]:
    raise SystemExit("packaged expired claim recovery targeted the wrong job")

from qa.contracts import ContractError, validate_fixture
from qa.privacy import PrivacyError, scan_tree
from qa.promote import (
    APPROVAL_KEYS,
    PROVENANCE_KEYS,
    PromotionError,
    _timestamp,
    _validate_approval,
)

expected = {"answer-memory", "job-apply", "job-search", "job-preferences", "job-workspace"}

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

invocation_pattern = re.compile(
    r"(?:\$|/)?job-apply:(answer-memory|job-apply|job-search|job-preferences|job-workspace)"
)
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

python3 - "$SMOKE_FIXTURE_DIR" "$SMOKE_TEMP_ROOT" <<'PY'
import base64
import http.client
import importlib.util
import json
import signal
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

fixture = Path(sys.argv[1])
smoke_root = Path(sys.argv[2])
launcher = fixture / "scripts" / "job-apply-workspace.py"
assets = [fixture / "workspace" / name for name in ("index.html", "app.js", "styles.css")]
if not launcher.is_file() or not all(asset.is_file() for asset in assets):
    raise SystemExit("packaged fixture is missing the Jobs workspace launcher or assets")

store_spec = importlib.util.spec_from_file_location("packaged_merge_store", fixture / "scripts" / "job-apply-store.py")
store_module = importlib.util.module_from_spec(store_spec)
store_spec.loader.exec_module(store_module)
recovery_store = store_module.Store(smoke_root / "merge-recovery-store", smoke_root / "no-legacy")
winner = recovery_store.put_answer({"question": "Packaged merge winner?", "state": "sensitive", "value": "packaged-winner-secret", "sensitivity": "high"}, remember_sensitive=True)
source = recovery_store.put_answer({"question": "Packaged merge duplicate?", "state": "confirmed", "value": "packaged-source-discarded"})
recovery_store.save_session("packaged-merge", {"status": "active", "answerKeys": [source["key"]]})
recovery_store.append_history({"applicationId": "packaged-merge", "event": "reviewed", "answerKeys": [source["key"]]})
real_atomic_write = store_module.atomic_write_json
interrupted = False
def interrupt_merge(path, payload):
    global interrupted
    if path == recovery_store._session_path("packaged-merge") and not interrupted:
        interrupted = True
        raise OSError("synthetic packaged merge interruption")
    return real_atomic_write(path, payload)
store_module.atomic_write_json = interrupt_merge
try:
    recovery_store.merge_answers(winner["key"], source["key"], winner["revision"], source["revision"])
    raise SystemExit("packaged merge recovery did not interrupt")
except OSError:
    pass
finally:
    store_module.atomic_write_json = real_atomic_write
recovered_store = store_module.Store(recovery_store.root, smoke_root / "no-legacy")
recovered_store.initialize()
merged = recovered_store.get_answer(winner["key"])
redirected = recovered_store.get_answer(source["key"])
session = recovered_store.load_session("packaged-merge")
if redirected.get("key") != winner["key"] or session.get("answerKeys") != [winner["key"]] or merged.get("referenceCounts", {}).get("history") != 1:
    raise SystemExit("packaged merge recovery or immutable-history resolution failed")
if "packaged-source-discarded" in recovery_store.answers_path.read_text(encoding="utf-8") or "packaged-winner-secret" in recovery_store.coordinator_journal_path.read_text(encoding="utf-8"):
    raise SystemExit("packaged merge recovery retained a source value or journaled an answer value")
process = subprocess.Popen(
    [sys.executable, str(launcher), "--root", str(smoke_root / "workspace-store"), "--port", "0", "--no-open", "--json"],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
try:
    details = json.loads(process.stdout.readline())
    parsed = urlsplit(details["url"])
    token = parsed.fragment.removeprefix("token=")
    connection = http.client.HTTPConnection("127.0.0.1", details["port"], timeout=5)
    host = f"127.0.0.1:{details['port']}"
    connection.request("GET", "/", headers={"Host": host})
    response = connection.getresponse()
    markup = response.read()
    if response.status != 200 or any(label not in markup for label in (b"Jobs Workspace", b"Facts Workspace", b"Resumes Workspace", b"Unified recovery")):
        raise SystemExit("packaged workspace did not serve its Jobs, Facts, Resumes, and Trash UI")
    connection.request("GET", "/api/state", headers={"Host": host, "Authorization": f"Bearer {token}"})
    response = connection.getresponse()
    state = json.loads(response.read())
    if response.status != 200 or state != {"jobs": [], "resumes": []}:
        raise SystemExit("packaged workspace did not read the canonical store")
    connection.request("GET", "/api/profile", headers={"Host": host, "Authorization": f"Bearer {token}"})
    response = connection.getresponse()
    profile = json.loads(response.read())
    if response.status != 200 or profile.get("profile") != {} or profile.get("revision") != 1:
        raise SystemExit("packaged workspace did not inspect the canonical profile")
    store_cli = [sys.executable, str(fixture / "scripts" / "job-apply-store.py"), "--root", str(smoke_root / "workspace-store")]
    created_job = json.loads(subprocess.run(
        [*store_cli, "job-create", "--input", "-"],
        input=json.dumps({"id": "trash-smoke-job", "url": "https://private.example/jobs/trash-smoke", "role": "Trash smoke"}),
        capture_output=True, text=True, check=True,
    ).stdout)
    trashed_job = json.loads(subprocess.run(
        [*store_cli, "job-trash", "--id", created_job["id"], "--expected-revision", str(created_job["revision"])],
        capture_output=True, text=True, check=True,
    ).stdout)
    trash_only = json.loads(subprocess.run(
        [*store_cli, "job-list", "--trashed-only"], capture_output=True, text=True, check=True,
    ).stdout)
    if [item.get("id") for item in trash_only] != [created_job["id"]]:
        raise SystemExit("packaged job trash-only CLI filtering failed")
    connection.request("GET", "/api/trash", headers={"Host": host, "Authorization": f"Bearer {token}"})
    response = connection.getresponse()
    unified = json.loads(response.read())
    if response.status != 200 or unified.get("counts", {}).get("job") != 1 or "private.example" in json.dumps(unified):
        raise SystemExit("packaged unified Trash projection was missing or exposed a job URL")
    restore_body = json.dumps({"expectedRevision": trashed_job["revision"]}).encode()
    connection.request("POST", f"/api/jobs/{created_job['id']}/restore", body=restore_body, headers={
        "Host": host, "Authorization": f"Bearer {token}", "Origin": f"http://{host}",
        "Content-Type": "application/json", "Content-Length": str(len(restore_body)),
    })
    response = connection.getresponse()
    restored_job = json.loads(response.read())
    if response.status != 200 or restored_job.get("deletedAt") is not None:
        raise SystemExit("packaged workspace job restore parity failed")
    source = smoke_root / "managed-smoke.txt"
    source.write_text("packaged managed resume", encoding="utf-8")
    created = subprocess.run(
        [
            sys.executable,
            str(fixture / "scripts" / "job-apply-store.py"),
            "--root",
            str(smoke_root / "workspace-store"),
            "resume-import",
            "--input",
            "-",
        ],
        input=json.dumps({"id": "smoke-resume", "label": "Smoke", "path": str(source)}),
        capture_output=True,
        text=True,
        check=True,
    )
    managed = json.loads(created.stdout)
    if managed.get("storageKind") != "managed" or "path" in managed:
        raise SystemExit("packaged resume import did not create a managed record")
    proposal_result = subprocess.run(
        [
            sys.executable,
            str(fixture / "scripts" / "job-apply-store.py"),
            "--root",
            str(smoke_root / "workspace-store"),
            "resume-proposal-create",
            "--resume-id",
            managed["id"],
            "--expected-resume-revision",
            str(managed["revision"]),
            "--expected-profile-revision",
            "1",
            "--input",
            "-",
        ],
        input=json.dumps({"email": "smoke@example.invalid"}),
        capture_output=True,
        text=True,
        check=True,
    )
    proposal = json.loads(proposal_result.stdout)
    if proposal.get("status") != "completed" or proposal.get("autoFilledPaths") != ["/email"]:
        raise SystemExit("packaged resume proposal did not auto-fill an empty fact")
    listed_result = subprocess.run(
        [
            sys.executable,
            str(fixture / "scripts" / "job-apply-store.py"),
            "--root",
            str(smoke_root / "workspace-store"),
            "resume-proposal-list",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    if len(json.loads(listed_result.stdout)) != 1:
        raise SystemExit("packaged resume proposal was not durable")
    source.unlink()
    connection.request("GET", "/api/resumes", headers={"Host": host, "Authorization": f"Bearer {token}"})
    response = connection.getresponse()
    projected = json.loads(response.read())
    records = projected.get("resumes", [])
    if response.status != 200 or len(records) != 1 or any(
        field in records[0] for field in ("path", "managedFile", "originalFilename", "digest")
    ):
        raise SystemExit("packaged workspace exposed private resume identity")
    upload = json.dumps({
        "metadata": {"id": "smoke-browser", "label": "Browser smoke"},
        "filename": "private-smoke-name.txt",
        "content": base64.b64encode(b"private browser smoke").decode("ascii"),
    }).encode()
    connection.request("POST", "/api/resumes/import", body=upload, headers={
        "Host": host, "Authorization": f"Bearer {token}", "Origin": f"http://{host}",
        "Content-Type": "application/json", "Content-Length": str(len(upload)),
    })
    response = connection.getresponse()
    imported = json.loads(response.read())
    if response.status != 200 or imported.get("id") != "smoke-browser":
        raise SystemExit("packaged workspace resume upload failed")
    connection.request("GET", "/api/resumes/smoke-browser/content", headers={"Host": host, "Authorization": f"Bearer {token}"})
    response = connection.getresponse()
    content = response.read()
    headers = dict(response.getheaders())
    if response.status != 200 or content != b"private browser smoke" or headers.get("Cache-Control") != "no-store" or "private-smoke-name" in headers.get("Content-Disposition", ""):
        raise SystemExit("packaged workspace private content delivery failed")
    connection.close()
    process.send_signal(signal.SIGINT)
    if process.wait(timeout=5) != 0:
        raise SystemExit("packaged workspace did not shut down cleanly")
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
print("Packaged Jobs, Facts, managed resume, extraction, Answers merge recovery, unified Trash API, and store launch passed")
PY

echo "Running Playwright and CLI walkthrough against packaged fixture"
JOB_WORKSPACE_TEST_ROOT="$SMOKE_FIXTURE_DIR" \
  node --test --test-name-pattern='real browser and CLI share CRUD|Needs Attention browser and CLI walkthrough' \
  "$REPO_ROOT/tests_js/workspace.test.mjs"
echo "Packaged Playwright and CLI walkthrough, including Needs Attention and unified Trash, passed"

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

for skill in answer-memory job-apply job-search job-preferences job-workspace; do
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

expected = {"answer-memory", "job-apply", "job-search", "job-preferences", "job-workspace"}
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
