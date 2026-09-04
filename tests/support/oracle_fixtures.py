import http.client
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
from urllib.parse import urlsplit

from qa.compiler import compile_capture
from qa.contracts import LEVER_CONTROL_PROFILE, generic_control
from qa.oracle import OracleError, evaluate_form_readiness, evaluate_run
from qa.server import ReplayHTTPServer
from scripts.job_apply_form_readiness import make_readiness_observation
from scripts.job_apply_policy import PolicyStore, confirmation_authority_revision


ROOT = Path(__file__).resolve().parents[2]
PRIVATE_CAPTURE = ROOT / "qa" / "testdata" / "private-capture"
RENDERER = ROOT / "qa" / "renderer"


def valid_fixture():
    capture = json.loads((PRIVATE_CAPTURE / "semantic.json").read_text())
    receipt = json.loads((PRIVATE_CAPTURE / "capture-receipt.json").read_text())
    return compile_capture(capture, receipt, "renderer-oracle-v1")

def complete_events(fixture=None):
    fixture = fixture or valid_fixture()
    events = []
    for step in fixture["steps"]:
        for control in step["controls"]:
            if not control["required"]:
                continue
            events.append(
                {
                    "type": "uploaded" if control["role"] == "file" else "filled",
                    "controlId": control["id"],
                    "stepId": step["id"],
                    **(
                        {"expectedFilenameMatched": True}
                        if control["role"] == "file"
                        else {}
                    ),
                }
            )
        if step["kind"] == "form":
            events.append(
                {"type": "advanced", "controlId": "", "stepId": step["id"]}
            )
        else:
            events.append(
                {"type": "reviewed", "controlId": "", "stepId": step["id"]}
            )
    return events

def history_event(event, application_id="application-1", **extra):
    return {
        "schemaVersion": 1,
        "eventId": f"event-{event}",
        "applicationId": application_id,
        "event": event,
        "answerKeys": ["question.stable"],
        "at": "2026-08-11T12:00:00Z",
        **extra,
    }

def valid_session(application_id="application-1"):
    return {
        "schemaVersion": 1,
        "applicationId": application_id,
        "status": "review",
        "ats": "synthetic-ats",
        "company": "Synthetic Company Secret",
        "role": "Synthetic Role Secret",
        "url": "https://example.com/private-application",
        "step": "review",
        "answerKeys": ["question.stable"],
        "pendingFields": [
            {
                "question": "Synthetic pending description secret",
                "state": "missing",
                "answerKey": "question.pending",
                "sensitive": False,
            }
        ],
        "createdAt": "2026-08-11T12:00:00Z",
        "updatedAt": "2026-08-11T12:01:00Z",
    }

def rich_replay_session(status="review", application_id="application-1"):
    session = valid_session(application_id)
    session.update(
        {
            "status": status,
            "attemptRevision": None,
            "readiness": None,
            "blockers": [],
            "approvals": [],
            "browserHandoff": {
                "state": "not_required" if status == "active" else "ready_for_owner",
                "reasonCode": "none" if status == "active" else "final-review-required",
                "revision": 1,
            },
        }
    )
    return session


class OracleStore:
    def __init__(self, root):
        self.root = Path(root)
        self.sessions = self.root / "sessions"
        self.sessions.mkdir(parents=True)

    def write_history(self, events):
        (self.root / "applications.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events),
            encoding="utf-8",
        )

    def write_session(self, session=None, name="application-1.json"):
        (self.sessions / name).write_text(
            json.dumps(session or valid_session()), encoding="utf-8"
        )

    def make_valid(self):
        self.write_history(
            [
                history_event(
                    "started",
                    company="Synthetic Company Secret",
                    role="Synthetic Role Secret",
                ),
                history_event("reviewed"),
            ]
        )
        self.write_session()
        return self


class SemanticOracleCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = OracleStore(Path(self.temporary.name) / "store").make_valid()
        self.fixture = valid_fixture()
        self.scenario = {"id": "complete-profile"}
        self.events = complete_events(self.fixture)

    def tearDown(self):
        self.temporary.cleanup()

    def evaluate(self, **overrides):
        return evaluate_run(
            overrides.get("fixture", self.fixture),
            overrides.get("scenario", self.scenario),
            overrides.get("events", self.events),
            overrides.get("store_root", self.store.root),
        )


class FormReadinessOracleCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(
            (
                ROOT
                / "qa/fixtures/greenhouse-form-readiness-v1/fixture.json"
            ).read_text(encoding="utf-8")
        )
        cls.states = {
            "contact.first_name": "complete",
            "contact.phone_country": "complete",
            "resume.file": "accepted",
            "authorization.sponsorship_select": "complete",
        }
