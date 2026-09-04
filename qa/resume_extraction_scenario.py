"""Deterministic resume extraction onboarding scenario."""

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any
from unittest import mock

from qa.resume_extraction_companion import (
    EXPECTED_FIXTURE_SHA256,
    RECEIPT_KEYS,
    ROOT,
    STORE,
    STORE_SCRIPT,
    WORKSPACE,
    Companion,
    OracleFailure,
    _require,
)


class Oracle:
    def __init__(self, fixture: Path, store_root: Path):
        self.fixture = fixture
        self.root = store_root
        self.private_dir = store_root.parent
        self.serializations: list[str] = []
        self.logs = io.StringIO()

    def cli(self, command: str, *args: str, record: bool = True) -> Any:
        completed = subprocess.run(
            [sys.executable, str(STORE_SCRIPT), "--root", str(self.root), command, *args],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise OracleFailure("cli operation failed")
        if record:
            self.serializations.extend((completed.stdout, completed.stderr))
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError:
            raise OracleFailure("cli response invalid") from None

    def candidate_file(self, name: str, candidate: dict[str, Any]) -> Path:
        path = self.private_dir / name
        path.write_text(json.dumps(candidate), encoding="utf-8")
        if os.name != "nt":
            path.chmod(0o600)
        return path

    @staticmethod
    def public_request(record: dict[str, Any]) -> dict[str, Any]:
        return WORKSPACE.public_extraction_request(record)

    def run(self) -> dict[str, bool]:
        fixture_bytes = self.fixture.read_bytes()
        _require(hashlib.sha256(fixture_bytes).hexdigest() == EXPECTED_FIXTURE_SHA256)
        replacement_bytes = fixture_bytes + b"\n% deterministic redacted replacement\n"

        human_first = "Current First"
        human_phone = "Current Phone"
        extracted_first = "Extracted First"
        extracted_phone = "Extracted Phone"
        extracted_email = "oracle-candidate@example.invalid"
        extracted_skill = "Oracle Candidate Skill"
        candidate = {
            "firstName": extracted_first,
            "phone": extracted_phone,
            "email": extracted_email,
            "skills": [extracted_skill],
        }

        with redirect_stderr(self.logs), Companion(self.root, self.logs) as companion:
            resume = companion.request(
                "POST",
                "/api/resumes/import",
                {"id": "oracle-resume", "label": "Oracle Redacted Resume"},
                upload=("redacted-oracle.pdf", fixture_bytes),
            )
            profile = companion.server.store.patch_profile(
                {"firstName": human_first, "phone": human_phone}, 1, "user"
            )
            request = companion.request(
                "POST",
                "/api/resume-extraction-requests",
                {"resumeId": resume["id"], "expectedResumeRevision": resume["revision"]},
            )
            cli_requests = self.cli(
                "resume-extraction-request-list", "--resume-id", resume["id"]
            )
            cli_request = self.cli(
                "resume-extraction-request-get", "--id", request["requestId"]
            )
            api_requests = companion.request("GET", "/api/resume-extraction-requests")
            request_shared = (
                len(cli_requests) == 1
                and cli_requests[0] == cli_request
                and self.public_request(cli_request) == request
                and api_requests == {"requests": [request]}
            )
            self.serializations.extend((
                json.dumps(request, sort_keys=True),
                json.dumps(api_requests, sort_keys=True),
            ))

            candidate_path = self.candidate_file("private-candidate.json", candidate)
            completed = self.cli(
                "resume-extraction-request-complete",
                "--id", request["requestId"],
                "--input", str(candidate_path),
                "--expected-request-revision", str(cli_request["revision"]),
                "--expected-profile-revision", str(profile["revision"]),
            )
            candidate_path.unlink()
            _require(not candidate_path.exists())
            _require(completed["request"]["status"] == "completed")
            proposal_id = completed["proposalSummary"]["id"]
            proposal = companion.request("GET", f"/api/resume-proposals/{proposal_id}")
            pending = set(proposal["pendingPaths"])
            autofill_observed = (
                proposal["autoFilledCount"] == 2
                and pending == {"/firstName", "/phone"}
                and companion.server.store.get_profile()["email"] == extracted_email
                and companion.server.store.get_profile()["skills"] == [extracted_skill]
            )
            app_source = (ROOT / "workspace" / "app.js").read_text(encoding="utf-8")
            grouped = all(fragment in app_source for fragment in (
                'return "Identity"', 'return "Contact"', 'return "Additional"'
            ))
            reviewed = companion.request(
                "POST",
                f"/api/resume-proposals/{proposal_id}/review",
                {
                    "decisions": {
                        "/firstName": "keep_current",
                        "/phone": "use_extracted",
                    },
                    "expectedRevision": proposal["revision"],
                    "expectedProfileRevision": proposal["liveProfileRevision"],
                },
            )
            after_review = companion.server.store.inspect_profile()
            conflicts_reviewed = (
                grouped
                and reviewed["status"] == "completed"
                and after_review["profile"]["firstName"] == human_first
                and after_review["profile"]["phone"] == extracted_phone
            )
            # Profile detail is deliberately value-bearing when explicitly invoked;
            # it is parity-checked but excluded from the value-free surface scan.
            cli_profile = self.cli("profile-inspect", record=False)
            api_profile = companion.request("GET", "/api/profile")
            profile_shared = cli_profile == api_profile == after_review

            stale_request = companion.request(
                "POST",
                "/api/resume-extraction-requests",
                {"resumeId": resume["id"], "expectedResumeRevision": resume["revision"]},
            )
            changed_resume = companion.request(
                "POST",
                f"/api/resumes/{resume['id']}/replace",
                {"expectedRevision": resume["revision"]},
                upload=("redacted-oracle-v2.pdf", replacement_bytes),
            )
            stale = self.cli(
                "resume-extraction-request-get", "--id", stale_request["requestId"]
            )
            content_change_staled = (
                stale["status"] == "stale"
                and changed_resume["revision"] == resume["revision"] + 1
            )
            retried = companion.request(
                "POST",
                f"/api/resume-extraction-requests/{stale['requestId']}/retry",
                {
                    "expectedRevision": stale["revision"],
                    "expectedResumeRevision": changed_resume["revision"],
                },
            )
            cancelled = companion.request(
                "POST",
                f"/api/resume-extraction-requests/{retried['requestId']}/cancel",
                {"expectedRevision": retried["revision"]},
            )

            conflict_request = companion.server.store.create_resume_extraction_request(
                resume["id"], changed_resume["revision"]
            )
            old_profile_revision = companion.server.store.inspect_profile()["revision"]
            proposals_before = len(companion.server.store.list_resume_proposals())
            companion.server.store.patch_profile(
                {"oracleConflictGuard": True}, old_profile_revision, "user"
            )
            profile_conflict_rejected = False
            try:
                companion.server.store.complete_resume_extraction_request(
                    conflict_request["requestId"],
                    {"profileConflictPrivate": "must-not-commit"},
                    conflict_request["revision"], old_profile_revision,
                )
            except STORE.StoreError:
                profile_conflict_rejected = True
            _require(
                companion.server.store.get_resume_extraction_request(
                    conflict_request["requestId"]
                )["status"] == "requested"
            )
            _require(len(companion.server.store.list_resume_proposals()) == proposals_before)
            companion.server.store.cancel_resume_extraction_request(
                conflict_request["requestId"], conflict_request["revision"]
            )

            race_request = companion.server.store.create_resume_extraction_request(
                resume["id"], changed_resume["revision"]
            )
            race_profile_revision = companion.server.store.inspect_profile()["revision"]
            race_proposals_before = len(companion.server.store.list_resume_proposals())

            def race_complete(marker: str) -> bool:
                contender = STORE.Store(self.root)
                try:
                    contender.complete_resume_extraction_request(
                        race_request["requestId"], {"racePrivate": marker},
                        race_request["revision"], race_profile_revision,
                    )
                    return True
                except STORE.StoreError:
                    return False

            with ThreadPoolExecutor(max_workers=2) as pool:
                race_results = list(pool.map(race_complete, ("winner-a", "winner-b")))
            race_rejected = (
                sorted(race_results) == [False, True]
                and len(companion.server.store.list_resume_proposals())
                == race_proposals_before + 1
                and companion.server.store.get_resume_extraction_request(
                    race_request["requestId"]
                )["status"] == "completed"
            )

            crash_request = companion.server.store.create_resume_extraction_request(
                resume["id"], changed_resume["revision"]
            )
            crash_profile_revision = companion.server.store.inspect_profile()["revision"]
            original_write = STORE.atomic_write_json
            journal_started = False
            injected = False

            def interrupt_once(path: Path, payload: Any) -> None:
                nonlocal journal_started, injected
                operation = payload.get("operation") if isinstance(payload, dict) else None
                if path == companion.server.store.resume_extraction_journal_path and operation:
                    journal_started = True
                if (
                    journal_started
                    and not injected
                    and path == companion.server.store.resume_extractions_path
                ):
                    injected = True
                    raise OSError("private injected interruption")
                original_write(path, payload)

            interrupted = False
            with mock.patch.object(STORE, "atomic_write_json", side_effect=interrupt_once):
                try:
                    companion.server.store.complete_resume_extraction_request(
                        crash_request["requestId"],
                        {"crashPrivate": "recovered-private"},
                        crash_request["revision"], crash_profile_revision,
                    )
                except OSError:
                    interrupted = True
            repaired = STORE.Store(self.root)
            repaired.initialize()
            crash_recovered = (
                interrupted
                and injected
                and repaired.get_resume_extraction_request(
                    crash_request["requestId"]
                )["status"] == "completed"
                and repaired.get_profile().get("crashPrivate") == "recovered-private"
                and repaired.get_resume_proposal(
                    repaired.get_resume_extraction_request(
                        crash_request["requestId"]
                    )["proposalId"]
                ) is not None
            )
            races_rejected = (
                cancelled["status"] == "cancelled"
                and profile_conflict_rejected
                and race_rejected
                and crash_recovered
            )

            api_preparedness = companion.request("GET", "/api/profile-preparedness")
            cli_preparedness = self.cli("profile-preparedness-get")
            _require(api_preparedness == cli_preparedness)
            self.serializations.extend((
                json.dumps(api_preparedness, sort_keys=True),
                json.dumps(cli_preparedness, sort_keys=True),
            ))

            handoff = (
                "Use the Job Apply resume workflow to process extraction request "
                f"{request['requestId']}."
            )
            self.serializations.append(handoff)

        skills = "\n".join(
            (ROOT / path).read_text(encoding="utf-8")
            for path in ("skills/job-apply/SKILL.md", "skills/job-workspace/SKILL.md")
        )
        agent_stopped_at_review = all(phrase in skills for phrase in (
            "delete the permission-restricted candidate file",
            "Stop at proposal review",
            "does not start or launch an agent",
            "opaque request ID",
        ))

        provisional = {
            "requestShared": request_shared,
            "autofillObserved": autofill_observed,
            "conflictsReviewed": conflicts_reviewed,
            "profileShared": profile_shared,
            "contentChangeStaled": content_change_staled,
            "racesRejected": races_rejected,
            "privacyVerified": False,
            "agentStoppedAtReview": agent_stopped_at_review,
            "passed": False,
        }
        scanned = "\n".join(self.serializations + [self.logs.getvalue(), json.dumps(provisional)])
        forbidden = (
            self.fixture.name,
            str(self.fixture),
            str(self.root),
            "redacted-oracle.pdf",
            "redacted-oracle-v2.pdf",
            "private-candidate.json",
            EXPECTED_FIXTURE_SHA256,
            base64.b64encode(fixture_bytes).decode("ascii")[:80],
            human_first,
            human_phone,
            extracted_first,
            extracted_phone,
            extracted_email,
            extracted_skill,
            "must-not-commit",
            "winner-a",
            "winner-b",
            "recovered-private",
            "private injected interruption",
            "Traceback",
        )
        privacy_verified = all(value not in scanned for value in forbidden)
        receipt = {**provisional, "privacyVerified": privacy_verified}
        receipt["passed"] = all(receipt[key] for key in RECEIPT_KEYS if key != "passed")
        _require(receipt["passed"])
        return receipt
