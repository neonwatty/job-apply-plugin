import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "job-apply-attempt.py"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


STORE = load_module("job_apply_attempt_store_tests", ROOT / "scripts" / "job-apply-store.py")
ATTEMPT = load_module("job_apply_attempt_tests", SCRIPT)


class AttemptProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store_root = self.root / "store"
        self.store = STORE.Store(self.store_root)
        revision = self.store.inspect_profile()["revision"]
        self.store.replace_profile({"firstName": "Private"}, revision, "user")
        resume_path = self.root / "private-resume.txt"
        resume_path.write_text("private resume", encoding="utf-8")
        self.store.create_resume({"id": "resume", "label": "Resume", "path": str(resume_path)})
        job = self.store.create_job({"id": "exact-job", "url": "https://example.invalid/exact"})
        self.job = self.store.transition_job(job["id"], "ready", job["revision"])
        self.input_counter = 0

    def tearDown(self):
        process_path = ATTEMPT.pid_path(self.store_root)
        try:
            pid = int(process_path.read_text(encoding="ascii"))
            os.kill(pid, signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError, ValueError):
            pass
        self.temporary.cleanup()

    def command(self, name, *args):
        return [sys.executable, str(SCRIPT), "--root", str(self.store_root), name, *args]

    def run_client(self, name, *args, payload=None):
        command = self.command(name, *args)
        if payload is not None:
            path = self.root / f"input-{self.input_counter}.json"
            self.input_counter += 1
            path.write_text(json.dumps(payload), encoding="utf-8")
            command.extend(["--input", str(path)])
        result = subprocess.run(command, text=True, capture_output=True, timeout=15)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 1, result)
        return command, result, json.loads(lines[0])

    def start(self):
        return self.run_client(
            "start", "--id", self.job["id"], "--owner", "fresh-agent",
            "--expected-revision", str(self.job["revision"]),
        )

    def readiness_input(self, attempt_revision, evidence_kind="agent_attested_current_attempt"):
        fixture = json.loads((
            ROOT / "qa" / "fixtures" / "greenhouse-form-readiness-v1" / "fixture.json"
        ).read_text(encoding="utf-8"))
        observation = STORE.FORM_READINESS_MODULE.make_readiness_observation(
            fixture,
            {
                "contact.first_name": "complete",
                "contact.phone_country": "complete",
                "resume.file": "accepted",
                "authorization.sponsorship_select": "complete",
            },
            observation_revision=9,
        )
        return {
            "attemptRevision": attempt_revision,
            "evidenceKind": evidence_kind,
            "fixture": fixture,
            "formManifest": STORE.FORM_READINESS_MODULE.make_form_manifest(
                fixture, observation_revision=9
            ),
            "observation": observation,
            "expectedObservationRevision": 9,
        }

    def test_launcher_group_can_die_and_later_independent_clients_finish_attempt(self):
        command = self.command(
            "start", "--id", self.job["id"], "--owner", "fresh-agent",
            "--expected-revision", str(self.job["revision"]),
        )
        launcher = subprocess.Popen(
            ["sh", "-c", '"$@"; sleep 30', "attempt-launcher", *command],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        assert launcher.stdout is not None
        acquired = json.loads(launcher.stdout.readline())
        self.assertTrue(acquired["ok"])
        launcher_group = os.getpgid(launcher.pid)
        os.killpg(launcher_group, signal.SIGKILL)
        launcher.wait(timeout=3)
        launcher.stdout.close()
        assert launcher.stderr is not None
        launcher.stderr.close()

        _command, heartbeat, response = self.run_client("heartbeat")
        self.assertEqual((heartbeat.returncode, response), (0, {"event": "heartbeat", "ok": True}))
        progress = {"status": "active", "step": "form", "answerKeys": [], "pendingFields": []}
        self.assertEqual(self.run_client("progress", payload=progress)[2]["event"], "progress_saved")
        review = {
            "status": "review", "step": "review", "answerKeys": [],
            "pendingFields": [], "attemptRevision": self.job["revision"] + 1,
            "readinessInput": self.readiness_input(self.job["revision"] + 1),
        }
        response = self.run_client("handoff", "--status", "awaiting_review", payload=review)[2]
        self.assertEqual(response, {"event": "handed_off", "ok": True, "status": "awaiting_review"})
        self.assertEqual(self.store.get_job(self.job["id"])["status"], "awaiting_review")
        self.assertIsNone(self.store.claim_status()["claim"])

    def test_awaiting_review_rejects_replay_or_stale_readiness_without_releasing_claim(self):
        self.start()
        attempt_revision = self.job["revision"] + 1
        replay = {
            "status": "review", "step": "review", "pendingFields": [],
            "attemptRevision": attempt_revision,
            "readinessInput": self.readiness_input(
                attempt_revision, evidence_kind="repository_replay"
            ),
        }
        response = self.run_client(
            "handoff", "--status", "awaiting_review", payload=replay
        )[2]
        self.assertEqual(response, {"error": {"code": "request_rejected"}, "ok": False})
        self.assertEqual(self.store.get_job(self.job["id"])["status"], "in_progress")
        self.assertIsNotNone(self.store.claim_status()["claim"])

    def test_bearer_is_absent_from_clients_outputs_and_broker_runtime_metadata(self):
        command, result, acquired = self.start()
        self.assertEqual(result.returncode, 0)
        coordinator = json.loads((self.store_root / "coordinator.json").read_text())
        bearer_hash = coordinator["claim"]["tokenHash"]
        visible = json.dumps(acquired) + " " + " ".join(command) + json.dumps(dict(os.environ))
        self.assertNotIn(bearer_hash, visible)
        self.assertNotIn("token", json.dumps(acquired).lower())
        self.assertNotIn("claim", json.dumps(acquired).lower())
        self.assertEqual(ATTEMPT.socket_path(self.store_root).stat().st_mode & 0o777, 0o600)
        runtime = ATTEMPT.pid_path(self.store_root).read_text(encoding="ascii")
        self.assertRegex(runtime, r"^\d+\n$")
        self.assertNotIn(bearer_hash, runtime)

    def test_broker_loss_leaves_exact_claim_and_new_start_fails_value_free(self):
        _command, _result, _acquired = self.start()
        before = self.store.claim_status()["claim"]
        process_path = ATTEMPT.pid_path(self.store_root)
        broker_pid = int(process_path.read_text(encoding="ascii"))
        os.kill(broker_pid, signal.SIGKILL)
        for _ in range(100):
            try:
                os.kill(broker_pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.01)
        after = self.store.claim_status()["claim"]
        self.assertEqual(after, before)

        command, failed, response = self.start()
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(response["ok"], False)
        self.assertIn(response["error"]["code"], {"request_rejected", "attempt_unavailable"})
        serialized = " ".join(command) + failed.stdout + failed.stderr
        self.assertNotIn(before["claimId"], serialized)
        self.assertNotIn(before["jobId"], failed.stdout)
        self.assertEqual(self.store.claim_status()["claim"], before)
        process_path.unlink(missing_ok=True)

    def test_exact_value_free_needs_info_handoff_records_lifecycle(self):
        command, _result, acquired = self.start()
        payload = {
            "status": "active", "step": "questions", "answerKeys": [],
            "pendingFields": [{
                "question": "How did you hear about this opportunity?", "state": "missing",
                "answerKey": "source.discovery", "sensitive": False,
            }],
        }
        response = self.run_client("handoff", "--status", "needs_info", payload=payload)[2]
        self.assertEqual(response, {"event": "handed_off", "ok": True, "status": "needs_info"})
        self.assertEqual(self.store.get_job(self.job["id"])["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        session = self.store.load_session(self.job["id"])
        self.assertEqual(
            {
                key: value for key, value in session["pendingFields"][0].items()
                if key not in {"reference", "questionFingerprint"}
            },
            {key: value for key, value in payload["pendingFields"][0].items() if key != "question"},
        )
        self.assertRegex(session["pendingFields"][0]["reference"], r"^pending_[a-f0-9]{32}$")
        self.assertRegex(session["pendingFields"][0]["questionFingerprint"], r"^[a-f0-9]{64}$")
        self.assertEqual([event["event"] for event in self.store.read_history()], ["job-started", "job-blocked"])
        visible = json.dumps(payload) + json.dumps(acquired) + " ".join(command)
        for forbidden in ("Private", "private resume", "token", "claim", "ownerLabel"):
            self.assertNotIn(forbidden, visible)

    def test_closed_store_scoped_command_surface_rejects_candidate_switch(self):
        self.start()
        with ATTEMPT.connect(ATTEMPT.socket_path(self.store_root)) as connection:
            ATTEMPT.send_response(connection, {"command": "progress", "id": "other", "session": {}})
            rejected = ATTEMPT.receive_request(connection)
        self.assertEqual(rejected, {"error": {"code": "request_rejected"}, "ok": False})
        self.assertEqual(self.run_client("heartbeat")[2], {"event": "heartbeat", "ok": True})

    def test_unsupported_invocation_never_contacts_or_changes_live_broker(self):
        self.start()
        before_claim = self.store.claim_status()["claim"]
        before_job = self.store.get_job(self.job["id"])
        before_sessions = self.store.list_sessions()
        before_pid = ATTEMPT.pid_path(self.store_root).read_text(encoding="ascii")

        _command, rejected, response = self.run_client("stop")

        self.assertEqual(rejected.returncode, 2)
        self.assertEqual(response, {"error": {"code": "invalid_invocation"}, "ok": False})
        self.assertEqual(self.store.claim_status()["claim"], before_claim)
        self.assertEqual(self.store.get_job(self.job["id"]), before_job)
        self.assertEqual(self.store.list_sessions(), before_sessions)
        self.assertEqual(ATTEMPT.pid_path(self.store_root).read_text(encoding="ascii"), before_pid)
        self.assertEqual(self.run_client("heartbeat")[2], {"event": "heartbeat", "ok": True})

    def test_invalid_invocation_is_distinct_from_genuine_broker_unavailability(self):
        unavailable_root = self.root / "unavailable-store"
        invalid = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(unavailable_root), "stop"],
            text=True, capture_output=True, timeout=15,
        )
        unavailable = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(unavailable_root), "heartbeat"],
            text=True, capture_output=True, timeout=15,
        )

        self.assertEqual(json.loads(invalid.stdout), {
            "error": {"code": "invalid_invocation"}, "ok": False,
        })
        self.assertEqual(json.loads(unavailable.stdout), {
            "error": {"code": "attempt_unavailable"}, "ok": False,
        })
        self.assertEqual((invalid.returncode, unavailable.returncode), (2, 2))
        self.assertFalse(unavailable_root.exists())


if __name__ == "__main__":
    unittest.main()
