#!/usr/bin/env python3
"""store lifecycle smoke assertions."""

import argparse
from pathlib import Path


def run(root: Path, smoke_root: Path) -> None:
    import json
    import hashlib
    import importlib.util
    import os
    import re
    import stat
    import subprocess
    import sys
    from pathlib import Path

    root = Path(root)
    smoke_root = Path(smoke_root)
    sys.path.insert(0, str(root))
    from scripts.job_apply_form_readiness import make_form_manifest

    legacy_home = smoke_root / "legacy-home"
    legacy_reports = legacy_home / ".claude-job-searches"
    legacy_reports.mkdir(parents=True)
    (legacy_reports / "search-smoke.md").write_text(
        "# Job Search Results — 2026-08-24\n"
        "## Results (ranked by score)\n"
        "### 1. Smoke Engineer — Example Co (Score: 90)\n"
        "- **Source**: Example\n"
        "- **URL**: https://example.com/jobs/smoke\n",
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
        nonlocal attention_counter
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
    review_attempt_revision = review_claim["job"]["revision"]
    review_observation_revision = 17
    review_fixture = json.loads((root / "qa" / "fixtures" / "greenhouse-form-readiness-v1" / "fixture.json").read_text(encoding="utf-8"))
    review_session = {
        "status": "review",
        "step": "review",
        "pendingFields": [],
        "answerKeys": [],
        "attemptRevision": review_attempt_revision,
        "readinessInput": {
            "attemptRevision": review_attempt_revision,
            "evidenceKind": "agent_attested_current_attempt",
            "fixture": review_fixture,
            "formManifest": make_form_manifest(
                review_fixture, observation_revision=review_observation_revision
            ),
            "expectedObservationRevision": review_observation_revision,
            "observation": {
                "schemaVersion": 1,
                "platformFamily": "greenhouse",
                "observationRevision": review_observation_revision,
                "adapterState": "accessible",
                "uploadCapability": "available",
                "controls": [
                    {"controlId": "authorization.sponsorship_select", "kind": "selection", "state": "complete", "observationRevision": review_observation_revision},
                    {"controlId": "contact.first_name", "kind": "text", "state": "complete", "observationRevision": review_observation_revision},
                    {"controlId": "contact.phone_country", "kind": "selection", "state": "complete", "observationRevision": review_observation_revision},
                    {"controlId": "resume.file", "kind": "upload", "state": "accepted", "observationRevision": review_observation_revision},
                ],
                "validationErrorControlIds": [],
                "finalControlState": "available",
            },
        },
    }
    review = attention_command("claim-handoff", review_session, "--id", review["id"], "--token", review_claim["token"], "--status", "awaiting_review", "--expected-revision", str(review_attempt_revision))["job"]
    review_session_path = attention_store / "sessions" / f"{review['id']}.json"
    review_session_bytes = review_session_path.read_bytes()
    review_restart = attention_command(
        "job-review-restart", None,
        "--id", review["id"], "--owner", "private-restart-owner",
        "--expected-revision", str(review["revision"]),
        "--owner-confirmed-not-submitted",
    )
    if review_restart["job"]["status"] != "in_progress" or review_session_path.read_bytes() != review_session_bytes:
        raise SystemExit("packaged review restart did not atomically preserve prior review evidence")
    review_session["attemptRevision"] = review_restart["job"]["revision"]
    review_session["readinessInput"]["attemptRevision"] = review_restart["job"]["revision"]
    review = attention_command(
        "claim-handoff", review_session,
        "--id", review["id"], "--token", review_restart["token"],
        "--status", "awaiting_review",
        "--expected-revision", str(review_restart["job"]["revision"]),
    )["job"]
    legacy_review = attention_ready("legacy-review-smoke", 4)
    legacy_claim = attention_command(
        "job-acquire", None,
        "--id", legacy_review["id"], "--owner", "private-legacy-owner",
        "--expected-revision", str(legacy_review["revision"]),
    )
    legacy_attempt_revision = legacy_claim["job"]["revision"]
    legacy_modern_review = json.loads(json.dumps(review_session))
    legacy_modern_review["attemptRevision"] = legacy_attempt_revision
    legacy_modern_review["readinessInput"]["attemptRevision"] = legacy_attempt_revision
    legacy_review = attention_command(
        "claim-handoff", legacy_modern_review,
        "--id", legacy_review["id"], "--token", legacy_claim["token"],
        "--status", "awaiting_review",
        "--expected-revision", str(legacy_attempt_revision),
    )["job"]
    legacy_session_path = attention_store / "sessions" / f"{legacy_review['id']}.json"
    legacy_session_path.write_text(json.dumps({
        "schemaVersion": 1,
        "applicationId": legacy_review["id"],
        "status": "review",
        "step": "final_review",
        "answerKeys": [],
        "pendingFields": [],
        "createdAt": "2026-08-01T00:00:00Z",
        "updatedAt": "2026-08-01T00:01:00Z",
    }, separators=(",", ":")), encoding="utf-8")
    legacy_session_bytes = legacy_session_path.read_bytes()
    legacy_restart = attention_command(
        "job-review-restart", None,
        "--id", legacy_review["id"], "--owner", "private-legacy-rebuild-owner",
        "--expected-revision", str(legacy_review["revision"]),
        "--owner-confirmed-not-submitted",
    )
    if (
        legacy_restart["job"]["status"] != "in_progress"
        or legacy_session_path.read_bytes() != legacy_session_bytes
    ):
        raise SystemExit("packaged legacy review rebuild did not preserve prior bytes")
    legacy_fresh_review = json.loads(json.dumps(review_session))
    legacy_fresh_review["step"] = "final_review"
    legacy_fresh_review["attemptRevision"] = legacy_restart["job"]["revision"]
    legacy_fresh_review["readinessInput"]["attemptRevision"] = legacy_restart["job"]["revision"]
    legacy_review = attention_command(
        "claim-handoff", legacy_fresh_review,
        "--id", legacy_review["id"], "--token", legacy_restart["token"],
        "--status", "awaiting_review",
        "--expected-revision", str(legacy_restart["job"]["revision"]),
    )["job"]
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
    legacy_session_path = attention_store / "sessions" / "legacy-smoke.json"
    legacy_pending = [{
        "question": "Private legacy compatibility question?",
        "state": "missing",
        "answerKey": "private.legacy.answer",
        "sensitive": True,
    }]
    legacy_session_path.write_text(json.dumps({
        "schemaVersion": 1,
        "applicationId": "legacy-smoke",
        "status": "active",
        "ats": "greenhouse",
        "step": "questions",
        "answerKeys": ["private.legacy.answer"],
        "pendingFields": legacy_pending,
        "createdAt": "2026-08-01T00:00:00Z",
        "updatedAt": "2026-08-01T00:01:00Z",
    }), encoding="utf-8")
    legacy_bytes = legacy_session_path.read_bytes()
    legacy_first = attention_command("session-load", None, "--id", "legacy-smoke")
    legacy_second = attention_command("session-load", None, "--id", "legacy-smoke")
    legacy_listed = attention_command("session-list")
    if legacy_first != legacy_second or legacy_session_path.read_bytes() != legacy_bytes:
        raise SystemExit("packaged legacy session projection was unstable or mutated bytes")
    legacy_serialized = json.dumps([legacy_first, legacy_listed])
    if "Private legacy compatibility question?" in legacy_serialized or "private.legacy.answer" not in legacy_serialized:
        raise SystemExit("packaged legacy session projection leaked question text or lost answer linkage")
    legacy_reference = legacy_first["pendingFields"][0].get("reference", "")
    if re.fullmatch(r"pending_[a-f0-9]{32}", legacy_reference) is None:
        raise SystemExit("packaged legacy session projection did not create an opaque reference")
    legacy_normalized = attention_command("session-save", {
        "status": "active",
        "step": "questions",
        "answerKeys": ["private.legacy.answer"],
        "pendingFields": legacy_pending,
    }, "--id", "legacy-smoke")
    if legacy_normalized["pendingFields"][0].get("reference") != legacy_reference:
        raise SystemExit("packaged legacy session normalization changed its projected reference")
    legacy_persisted = json.loads(legacy_session_path.read_text(encoding="utf-8"))
    if legacy_persisted != legacy_normalized or any("question" in field for field in legacy_persisted["pendingFields"]):
        raise SystemExit("packaged legacy session normalization was incomplete")
    attention_projection = store_module.Store(attention_store).list_needs_attention()
    if [item["reasonCode"] for item in attention_projection["items"]] != ["expired_agent_attempt", "claimless_interrupted_attempt", "awaiting_human_review", "awaiting_human_review", "needs_information"]:
        raise SystemExit("packaged Needs Attention taxonomy or ordering failed")
    attention_serialized = json.dumps(attention_projection)
    for forbidden in (
        expired_claim["token"], review_restart["token"], legacy_restart["token"],
        "private-expired-owner", "private-review-owner", "private-legacy-owner",
        "private-legacy-rebuild-owner",
        "private-restart-owner",
        "private-needs-owner", "Private question?", "private.answer.key", "answerKey",
        "tokenHash", "claimId", "ownerLabel", "operationId", "browserState",
        "Smoke Co",
    ):
        if forbidden in attention_serialized:
            raise SystemExit("packaged Needs Attention projection leaked private coordinator or answer data")
    recovered = attention_command("claim-recover", None, "--id", expired["id"], "--owner", "replacement-owner")
    interrupted = attention_command("job-transition", None, "--id", interrupted["id"], "--status", "needs_info", "--expected-revision", str(interrupted["revision"]))
    attention_command("job-transition", None, "--id", interrupted["id"], "--status", "saved", "--expected-revision", str(interrupted["revision"]))
    attention_command("job-transition", None, "--id", needs["id"], "--status", "saved", "--expected-revision", str(needs["revision"]))
    attention_command("job-transition", None, "--id", review["id"], "--status", "applied", "--expected-revision", str(review["revision"]), "--user-confirmed")
    attention_command("job-transition", None, "--id", legacy_review["id"], "--status", "applied", "--expected-revision", str(legacy_review["revision"]), "--user-confirmed")
    if store_module.Store(attention_store).list_needs_attention()["items"]:
        raise SystemExit("packaged Needs Attention resolutions did not converge to empty")
    if recovered["job"]["id"] != expired["id"]:
        raise SystemExit("packaged expired claim recovery targeted the wrong job")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("smoke_root", type=Path)
    arguments = parser.parse_args()
    run(arguments.root, arguments.smoke_root)


if __name__ == "__main__":
    main()
