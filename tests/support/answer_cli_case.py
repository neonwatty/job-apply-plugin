import json
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "job-apply-store.py"
READINESS_SPEC = importlib.util.spec_from_file_location(
    "job_apply_form_readiness", ROOT / "scripts" / "job_apply_form_readiness.py"
)
READINESS = importlib.util.module_from_spec(READINESS_SPEC)
READINESS_SPEC.loader.exec_module(READINESS)


class AnswerCliCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.environment = dict(os.environ)
        self.environment["HOME"] = str(self.home)
        self.environment.pop("JOB_APPLY_STORE_DIR", None)

    def tearDown(self):
        self.temporary.cleanup()

    def write_input(self, name, payload):
        path = self.home / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        if os.name != "nt":
            path.chmod(0o600)
        return path

    def run_store(self, *arguments, check=True):
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            check=False,
            capture_output=True,
            text=True,
            env=self.environment,
        )
        if check and completed.returncode != 0:
            self.fail(f"store command failed: {arguments}: {completed.stderr}")
        return completed

    def json_store(self, *arguments):
        return json.loads(self.run_store(*arguments).stdout)

    def review_session(self, attempt_revision):
        fixture = json.loads((
            ROOT / "qa" / "fixtures" / "greenhouse-form-readiness-v1" / "fixture.json"
        ).read_text(encoding="utf-8"))
        observation = READINESS.make_readiness_observation(
            fixture,
            {
                "contact.first_name": "complete",
                "contact.phone_country": "complete",
                "resume.file": "accepted",
                "authorization.sponsorship_select": "complete",
            },
            observation_revision=13,
        )
        return {
            "status": "review", "step": "review", "answerKeys": [],
            "pendingFields": [], "attemptRevision": attempt_revision,
            "readinessInput": {
                "attemptRevision": attempt_revision,
                "evidenceKind": "agent_attested_current_attempt",
                "fixture": fixture,
                "formManifest": READINESS.make_form_manifest(
                    fixture, observation_revision=13
                ),
                "observation": observation,
                "expectedObservationRevision": 13,
            },
        }
