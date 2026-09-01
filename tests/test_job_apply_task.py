import importlib.util
import hashlib
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


STORE = load_module("job_apply_task_store_tests", ROOT / "scripts" / "job-apply-store.py")


class TaskProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store_root = self.root / "store"
        self.store = STORE.Store(self.store_root)
        self.task = [
            sys.executable,
            str(ROOT / "scripts" / "job-apply-task.py"),
            "--root",
            str(self.store_root),
        ]

    def tearDown(self):
        self.temporary.cleanup()

    def command(self, command, *arguments, payload=None, check=True):
        final = [*self.task, command, *arguments]
        if payload is not None:
            input_path = self.root / f"{command}-input.json"
            input_path.write_text(json.dumps(payload), encoding="utf-8")
            final.extend(["--input", str(input_path)])
        completed = subprocess.run(final, capture_output=True, text=True, check=False)
        if check:
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(completed.stderr, "")
        return completed.returncode, json.loads(completed.stdout)

    def make_ready_environment(self):
        profile_revision = self.store.inspect_profile()["revision"]
        self.store.replace_profile({"firstName": "Private"}, profile_revision, "user")
        resume_path = self.root / "private-resume.txt"
        resume_path.write_text("private resume content", encoding="utf-8")
        self.store.create_resume({"id": "resume-primary", "label": "Primary", "path": str(resume_path)})

    def test_intake_atomically_creates_or_resolves_one_job_without_token_or_url(self):
        private_url = "https://example.invalid/private/job?candidate=secret"
        _code, created = self.command(
            "intake", payload={"url": private_url, "role": "Engineer", "company": "Example"}
        )
        self.assertEqual((created["ok"], created["action"]), (True, "create"))
        self.assertNotIn("token", json.dumps(created).lower())
        self.assertNotIn(private_url, json.dumps(created))
        job_id = created["job"]["id"]

        _code, resolved = self.command("intake", payload={"url": private_url})
        self.assertEqual((resolved["action"], resolved["job"]["id"]), ("noop", job_id))
        self.assertEqual(len(self.store.list_jobs()), 1)

    def test_conflicting_or_trashed_identity_fails_closed_and_is_redacted(self):
        private_url = "https://example.invalid/private/conflict?token=secret"
        job = self.store.intake_task_job({"url": private_url})["job"]
        self.store.trash_job(job["id"], job["revision"])
        code, rejected = self.command("intake", payload={"url": private_url}, check=False)
        self.assertEqual((code, rejected["ok"], rejected["error"]["code"]), (2, False, "job_identity_conflict"))
        self.assertNotIn(private_url, json.dumps(rejected))
        self.assertNotIn("secret", json.dumps(rejected))

    def test_snapshot_and_exact_activity_are_store_owned_and_redacted(self):
        private_url = "https://example.invalid/private/snapshot?secret=yes"
        job = self.store.intake_task_job(
            {"url": private_url, "role": "Engineer", "company": "Example"}
        )["job"]
        _code, snapshot = self.command("snapshot")
        self.assertEqual(snapshot["snapshot"]["jobs"][0]["id"], job["id"])
        self.assertIn("overview", snapshot["snapshot"])
        self.assertIn("attention", snapshot["snapshot"])
        self.assertNotIn(private_url, json.dumps(snapshot))
        _code, activity = self.command("activity", "--id", job["id"])
        self.assertEqual(activity["jobId"], job["id"])
        self.assertEqual(activity["activity"]["job"]["revision"], job["revision"])

    def test_snapshot_is_one_locked_revision_during_concurrent_job_write(self):
        job = self.store.intake_task_job({
            "url": "https://example.invalid/concurrent",
            "role": "Before",
            "company": "Example",
        })["job"]
        job = self.store.transition_job(job["id"], "needs_info", job["revision"])
        snapshot_ready = self.root / "snapshot-ready"
        snapshot_release = self.root / "snapshot-release"
        writer_ready = self.root / "writer-ready"
        writer_go = self.root / "writer-go"
        writer_attempted = self.root / "writer-attempted"
        writer_acquired = self.root / "writer-acquired"
        module_path = ROOT / "scripts" / "job-apply-store.py"
        snapshot_source = r'''
import importlib.util, json, pathlib, sys, time
module_path, root, ready, release = map(pathlib.Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location("snapshot_store", module_path)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
store = module.Store(root); store.initialize(); store._ensure_coordinator_files()
store.initialize = lambda: {"initialized": True}
store._ensure_coordinator_files = lambda: None
load_jobs = store._load_jobs_document
def gated_load():
    document = load_jobs()
    ready.touch()
    deadline = time.monotonic() + 5
    while not release.exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("snapshot release timed out")
        time.sleep(0.01)
    return document
store._load_jobs_document = gated_load
print(json.dumps(store.task_snapshot(), sort_keys=True))
'''
        writer_source = r'''
import importlib.util, json, pathlib, sys, time
module_path, root, ready, go, attempted, acquired, job_id, revision = sys.argv[1:]
spec = importlib.util.spec_from_file_location("writer_store", module_path)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
store = module.Store(pathlib.Path(root)); store.initialize()
store.initialize = lambda: {"initialized": True}
load_jobs = store._load_jobs_document
def marked_load():
    pathlib.Path(acquired).touch()
    return load_jobs()
store._load_jobs_document = marked_load
pathlib.Path(ready).touch()
deadline = time.monotonic() + 5
while not pathlib.Path(go).exists():
    if time.monotonic() >= deadline:
        raise RuntimeError("writer start timed out")
    time.sleep(0.01)
pathlib.Path(attempted).touch()
updated = store.update_job(job_id, {"role": "After"}, int(revision))
print(json.dumps({"revision": updated["revision"]}, sort_keys=True))
'''
        writer_process = subprocess.Popen(
            [sys.executable, "-c", writer_source, str(module_path),
             str(self.store_root), str(writer_ready), str(writer_go),
             str(writer_attempted), str(writer_acquired), job["id"],
             str(job["revision"])],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        snapshot_process = None
        try:
            deadline = time.monotonic() + 5
            while not writer_ready.exists() and time.monotonic() < deadline:
                self.assertIsNone(writer_process.poll(), "writer exited before ready barrier")
                time.sleep(0.01)
            self.assertTrue(writer_ready.exists(), "writer did not initialize")
            snapshot_process = subprocess.Popen(
                [sys.executable, "-c", snapshot_source, str(module_path),
                 str(self.store_root), str(snapshot_ready), str(snapshot_release)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            deadline = time.monotonic() + 5
            while not snapshot_ready.exists() and time.monotonic() < deadline:
                self.assertIsNone(snapshot_process.poll(), "snapshot exited before barrier")
                time.sleep(0.01)
            self.assertTrue(snapshot_ready.exists(), "snapshot did not reach locked barrier")
            writer_go.touch()
            deadline = time.monotonic() + 5
            while not writer_attempted.exists() and time.monotonic() < deadline:
                self.assertIsNone(writer_process.poll(), "writer exited before lock attempt")
                time.sleep(0.01)
            self.assertTrue(writer_attempted.exists(), "writer did not attempt the lock")
            lock_probe_deadline = time.monotonic() + 0.2
            while not writer_acquired.exists() and time.monotonic() < lock_probe_deadline:
                self.assertIsNone(writer_process.poll(), "writer exited during lock probe")
                time.sleep(0.01)
            self.assertFalse(writer_acquired.exists(), "writer bypassed the snapshot lock")
            snapshot_release.touch()
            snapshot_stdout, snapshot_stderr = snapshot_process.communicate(timeout=5)
            writer_stdout, writer_stderr = writer_process.communicate(timeout=5)
            self.assertEqual(snapshot_process.returncode, 0, snapshot_stderr)
            self.assertEqual(writer_process.returncode, 0, writer_stderr)
            self.assertTrue(writer_acquired.exists())
            snapshot = json.loads(snapshot_stdout)
            self.assertEqual(snapshot["overview"]["counts"]["attentionJobs"], 1)
            self.assertEqual(snapshot["jobs"][0]["revision"], job["revision"])
            self.assertEqual(snapshot["jobs"][0]["role"], "Before")
            self.assertEqual(snapshot["attention"]["items"][0]["revision"], job["revision"])
            self.assertEqual(snapshot["attention"]["items"][0]["role"], "Before")
            signature_input = {
                "overview": snapshot["overview"],
                "jobs": snapshot["jobs"],
                "attentionSignature": snapshot["attention"]["snapshotSignature"],
            }
            expected_signature = hashlib.sha256(
                STORE._canonical_json(signature_input).encode("utf-8")
            ).hexdigest()
            self.assertEqual(snapshot["snapshotSignature"], expected_signature)
            self.assertEqual(json.loads(writer_stdout)["revision"], job["revision"] + 1)
        finally:
            writer_go.touch()
            snapshot_release.touch()
            for process in (writer_process, snapshot_process):
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.communicate(timeout=2)

    def test_selection_requires_owner_confirmation_exact_revision_and_preflight(self):
        job = self.store.intake_task_job({"url": "https://example.invalid/select"})["job"]
        code, unconfirmed = self.command(
            "select", "--id", job["id"], "--expected-revision", str(job["revision"]), check=False
        )
        self.assertEqual((code, unconfirmed["error"]["code"]), (2, "owner_confirmation_required"))
        code, failed = self.command(
            "select", "--id", job["id"], "--expected-revision", str(job["revision"]),
            "--owner-confirmed", check=False,
        )
        self.assertEqual((code, failed["error"]["code"]), (2, "preflight_failed"))

        self.make_ready_environment()
        _code, selected = self.command(
            "select", "--id", job["id"], "--expected-revision", str(job["revision"]),
            "--owner-confirmed",
        )
        self.assertEqual((selected["action"], selected["job"]["status"]), ("ready", "ready"))
        code, stale = self.command(
            "select", "--id", job["id"], "--expected-revision", str(job["revision"]),
            "--owner-confirmed", check=False,
        )
        self.assertEqual((code, stale["error"]["code"]), (2, "stale_revision"))

        ready_revision = selected["job"]["revision"]
        _code, no_op = self.command(
            "select", "--id", job["id"], "--expected-revision", str(ready_revision),
            "--owner-confirmed",
        )
        self.assertEqual((no_op["action"], no_op["job"]["revision"]), ("noop", ready_revision))

    def test_pending_answer_task_requires_confirmation_and_exact_safe_revisions(self):
        self.make_ready_environment()
        job = self.store.create_job({
            "id": "pending-task", "url": "https://example.invalid/pending-task",
            "role": "Engineer", "company": "Example",
        })
        job = self.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.store.acquire_ready_job(job["id"], "owner", job["revision"])
        pending = {
            "status": "active", "step": "questions", "pendingFields": [{
                "question": "Authorization?", "state": "missing",
                "answerKey": "safe", "sensitive": False,
            }],
        }
        self.store.save_claim_progress(job["id"], acquired["token"], pending)
        blocked = self.store.handoff_claimed_job(
            job["id"], acquired["token"], "needs_info", pending,
            acquired["job"]["revision"],
        )
        answer = self.store.put_answer({
            "key": "safe", "state": "confirmed", "value": "private value",
        })
        activity = self.store.get_job_activity(job["id"])
        reference = activity["session"]["pendingInformation"][0]["reference"]
        self.assertLessEqual(activity["session"]["revision"], 2 ** 53 - 1)
        arguments = (
            "--id", job["id"], "--reference", reference,
            "--expected-job-revision", str(blocked["job"]["revision"]),
            "--expected-session-revision", str(activity["session"]["revision"]),
            "--expected-answer-revision", str(answer["revision"]),
        )
        code, unconfirmed = self.command(
            "resolve-pending-answer", *arguments, check=False
        )
        self.assertEqual((code, unconfirmed["error"]["code"]), (2, "owner_confirmation_required"))
        self.assertEqual(self.store.get_job(job["id"])["status"], "needs_info")
        code, stale = self.command(
            "resolve-pending-answer", *arguments[:-1], str(answer["revision"] + 1),
            "--owner-confirmed", check=False,
        )
        self.assertEqual((code, stale["error"]["code"]), (2, "stale_revision"))
        _code, resolved = self.command(
            "resolve-pending-answer", *arguments, "--owner-confirmed"
        )
        self.assertTrue(resolved["ready"])
        self.assertNotIn("private value", json.dumps(resolved))

    def test_invalid_input_and_unavailable_activity_use_stable_json_errors(self):
        invalid = self.root / "invalid.json"
        invalid.write_text("not-json https://private.invalid/secret", encoding="utf-8")
        code, failure = self.command("intake", "--input", str(invalid), check=False)
        self.assertEqual((code, failure["error"]["code"]), (2, "invalid_request"))
        self.assertNotIn("private.invalid", json.dumps(failure))
        code, missing = self.command("activity", "--id", "job-missing", check=False)
        self.assertEqual((code, missing["error"]["code"]), (2, "job_unavailable"))

    def test_store_module_initialization_failure_is_redacted_json(self):
        isolated = self.root / "isolated-helper"
        isolated.mkdir()
        task_copy = isolated / "job-apply-task.py"
        task_copy.write_bytes((ROOT / "scripts" / "job-apply-task.py").read_bytes())
        (isolated / "job-apply-store.py").write_text(
            "raise RuntimeError('private path /Users/applicant and https://private.invalid')\n",
            encoding="utf-8",
        )
        completed = subprocess.run(
            [sys.executable, str(task_copy), "snapshot"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stderr, "")
        self.assertEqual(json.loads(completed.stdout), {
            "ok": False,
            "error": {
                "code": "store_unavailable",
                "message": "The canonical store is unavailable.",
            },
        })
        self.assertNotIn("Traceback", completed.stdout)
        self.assertNotIn("private.invalid", completed.stdout)


if __name__ == "__main__":
    unittest.main()
