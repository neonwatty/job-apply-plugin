import base64
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from qa.recorder_fs import (
    BrokerError,
    SessionBroker,
    _bounded_lines,
    exclusive_rename,
)


class ExclusiveRenameTests(unittest.TestCase):
    def test_real_exclusive_rename_preserves_existing_destination(self):
        if sys.platform != "darwin":
            self.skipTest("real renameatx_np integration is Darwin-specific")
        with tempfile.TemporaryDirectory() as directory:
            parent_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                Path(directory, "source").write_text("source")
                Path(directory, "destination").write_text("destination")
                with self.assertRaisesRegex(BrokerError, "destination-exists"):
                    exclusive_rename(parent_fd, "source", parent_fd, "destination")
                self.assertEqual(Path(directory, "source").read_text(), "source")
                self.assertEqual(Path(directory, "destination").read_text(), "destination")
            finally:
                os.close(parent_fd)

    def test_real_exclusive_rename_moves_to_absent_name_and_refuses_symlink(self):
        if sys.platform != "darwin":
            self.skipTest("real renameatx_np integration is Darwin-specific")
        with tempfile.TemporaryDirectory() as directory:
            parent_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                Path(directory, "source").write_text("source")
                exclusive_rename(parent_fd, "source", parent_fd, "destination")
                self.assertFalse(Path(directory, "source").exists())
                self.assertEqual(Path(directory, "destination").read_text(), "source")
                Path(directory, "next").write_text("next")
                Path(directory, "target").write_text("target")
                os.symlink("target", Path(directory, "linked"))
                with self.assertRaisesRegex(BrokerError, "destination-exists"):
                    exclusive_rename(parent_fd, "next", parent_fd, "linked")
                self.assertEqual(Path(directory, "target").read_text(), "target")
                self.assertEqual(Path(directory, "next").read_text(), "next")
            finally:
                os.close(parent_fd)

    def test_adapter_failures_are_value_free(self):
        with mock.patch("qa.recorder_fs._exclusive_rename_raw", return_value=errno.EACCES):
            with self.assertRaises(BrokerError) as caught:
                exclusive_rename(4, "private-source", 5, "private-destination")
        self.assertEqual(str(caught.exception), "rename-failed")


class SessionBrokerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.private = self.base / ".qa-private"
        self.private.mkdir(mode=0o700)
        self.session = self.private / "qa-session-test"
        self.broker = SessionBroker(str(self.session))

    def tearDown(self):
        self.broker.close()
        self.temporary.cleanup()

    def test_private_permissions_and_closed_safe_paths(self):
        self.assertEqual(self.session.stat().st_mode & 0o777, 0o700)
        for unsafe in (
            "", ".", "..", "a/../b", "a/./b", "a//b", "a/", "a\\b",
            "/absolute", "a\x00b",
        ):
            with self.subTest(unsafe=repr(unsafe)):
                with self.assertRaises(BrokerError):
                    self.broker.mkdir(unsafe)
        self.broker.mkdir("checkpoints")
        self.broker.write_exclusive("events.jsonl", b"event\n")
        self.assertEqual((self.session / "events.jsonl").stat().st_mode & 0o777, 0o600)

    def test_private_parent_requires_exact_owner_mode(self):
        for mode in (0o500, 0o600, 0o700 | 0o001, 0o710, 0o750, 0o770):
            with self.subTest(mode=oct(mode)), tempfile.TemporaryDirectory() as directory:
                private = Path(directory, ".qa-private")
                private.mkdir(mode=0o700)
                private.chmod(mode)
                try:
                    with self.assertRaisesRegex(BrokerError, "unsafe-root"):
                        SessionBroker(str(private / "qa-session-mode"))
                finally:
                    private.chmod(0o700)

        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory, ".qa-private")
            private.mkdir(mode=0o700)
            broker = SessionBroker(str(private / "qa-session-exact"))
            broker.close()

    def test_close_releases_retained_descriptors(self):
        root_fd = self.broker._root_fd
        parent_fd = self.broker._parent_fd
        self.broker.close()
        for descriptor in (root_fd, parent_fd):
            with self.assertRaises(OSError) as caught:
                os.fstat(descriptor)
            self.assertEqual(caught.exception.errno, errno.EBADF)

    def test_root_path_swap_cannot_redirect_evidence(self):
        moved = self.private / "anchored"
        target = self.base / "target"
        target.mkdir(mode=0o700)
        self.session.rename(moved)
        os.symlink(target, self.session)
        self.broker.write_exclusive("events.jsonl", b"anchored")
        self.assertEqual((moved / "events.jsonl").read_bytes(), b"anchored")
        self.assertFalse((target / "events.jsonl").exists())

    def test_intermediate_symlink_is_never_followed(self):
        target = self.base / "target"
        target.mkdir(mode=0o700)
        os.symlink(target, self.session / "checkpoints")
        with self.assertRaisesRegex(BrokerError, "unsafe-path"):
            self.broker.write_exclusive("checkpoints/page.html", b"private")
        self.assertFalse((target / "page.html").exists())

    def test_exclusive_replace_append_remove_and_hash(self):
        self.broker.mkdir("checkpoints")
        self.broker.mkdir("checkpoints/.tmp-one")
        self.broker.write_exclusive("events.jsonl", b"one")
        self.broker.append("events.jsonl", b"two")
        self.broker.write_exclusive("checkpoints/.tmp-one/page.html", b"html")
        self.broker.write_exclusive("checkpoints/.tmp-one/page.png", b"png")
        self.broker.write_exclusive("checkpoints/.tmp-one/controls.json", b"controls")
        self.broker.write_exclusive("checkpoints/.tmp-one/checkpoint.json", b"checkpoint")
        self.broker.rename_no_replace("checkpoints/.tmp-one", "checkpoints/0001-application-opened")
        self.broker.atomic_replace("recording-summary.json", b"summary")
        source = self.broker.hash_source_files()
        self.assertEqual(source["events.jsonl"], hashlib.sha256(b"onetwo").hexdigest())
        self.assertEqual(
            source["checkpoints/0001-application-opened/page.html"],
            hashlib.sha256(b"html").hexdigest(),
        )
        self.broker.remove_tree("checkpoints/0001-application-opened")
        self.assertFalse((self.session / "checkpoints/0001-application-opened").exists())

    def test_file_and_session_budgets_fail_closed(self):
        self.broker.max_file_bytes = 4
        self.broker.max_session_bytes = 6
        self.broker.write_exclusive("one", b"1234")
        with self.assertRaisesRegex(BrokerError, "file-budget"):
            self.broker.write_exclusive("two", b"12345")
        self.broker.write_exclusive("two", b"12")
        with self.assertRaisesRegex(BrokerError, "session-budget"):
            self.broker.append("two", b"3")


class BrokerProtocolTests(unittest.TestCase):
    def test_line_reader_discards_oversized_requests_without_losing_next_request(self):
        stream = io.BytesIO(b"x" * 9 + b"tail\n{}\n")
        self.assertEqual(list(_bounded_lines(stream, 8)), [None, b"{}\n"])

    def test_protocol_is_closed_bounded_and_value_free(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory, ".qa-private")
            private.mkdir(mode=0o700)
            session = private / "qa-session-protocol"
            child = subprocess.Popen(
                [sys.executable, "-m", "qa.recorder_fs", "--root", str(session)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                ready = json.loads(child.stdout.readline())
                self.assertEqual(ready, {"ready": True})
                requests = [
                    {"id": 1, "command": "mkdir", "path": "checkpoints"},
                    {"id": 2, "command": "unknown", "private": "secret-value"},
                    {"id": 3, "command": "write-exclusive", "path": "private-name", "data": "%%%"},
                    {"id": 4, "command": "write-exclusive", "path": "control.json",
                     "data": base64.b64encode(b"private-control").decode("ascii")},
                ]
                responses = []
                for request in requests:
                    child.stdin.write(json.dumps(request) + "\n")
                    child.stdin.flush()
                    responses.append(json.loads(child.stdout.readline()))
                self.assertTrue(responses[0]["ok"])
                self.assertEqual(responses[1]["code"], "invalid-request")
                self.assertEqual(responses[2]["code"], "invalid-data")
                self.assertNotIn("secret-value", json.dumps(responses))
            finally:
                child.stdin.close()
                child.wait(timeout=3)
            self.assertEqual(child.stderr.read(), "")
            self.assertFalse((session / "control.json").exists())
            child.stdout.close()
            child.stderr.close()

    def test_blocked_broker_signal_still_removes_control_file(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory, ".qa-private")
            private.mkdir(mode=0o700)
            session = private / "qa-session-blocked"
            child = subprocess.Popen(
                [sys.executable, "-m", "qa.recorder_fs", "--root", str(session)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(json.loads(child.stdout.readline()), {"ready": True})
                child.stdin.write(json.dumps({
                    "id": 1,
                    "command": "write-exclusive",
                    "path": "control.json",
                    "data": base64.b64encode(b"private-control").decode("ascii"),
                }) + "\n")
                child.stdin.flush()
                self.assertTrue(json.loads(child.stdout.readline())["ok"])
                os.mkfifo(session / "blocked", 0o600)
                child.stdin.write(json.dumps({
                    "id": 2,
                    "command": "append",
                    "path": "blocked",
                    "data": base64.b64encode(b"blocked").decode("ascii"),
                }) + "\n")
                child.stdin.flush()
                self.assertEqual(select.select([child.stdout], [], [], 0.2)[0], [])
                child.kill()
                child.wait(timeout=3)
                deadline = time.monotonic() + 2
                while (session / "control.json").exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertFalse((session / "control.json").exists())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=3)
                child.stdin.close()
                child.stdout.close()
                child.stderr.close()

    def test_process_group_signals_leave_guardian_to_remove_control(self):
        for sent_signal in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=sent_signal), tempfile.TemporaryDirectory() as directory:
                private = Path(directory, ".qa-private")
                private.mkdir(mode=0o700)
                session = private / "qa-session-group-signal"
                child = subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        (
                            "import os, signal, sys; "
                            "signal.signal(int(sys.argv[1]), signal.SIG_IGN); "
                            "os.execv(sys.executable, [sys.executable, '-m', "
                            "'qa.recorder_fs', '--root', sys.argv[2]])"
                        ),
                        str(int(sent_signal)),
                        str(session),
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    start_new_session=True,
                )
                try:
                    self.assertEqual(json.loads(child.stdout.readline()), {"ready": True})
                    child.stdin.write(json.dumps({
                        "id": 1,
                        "command": "write-exclusive",
                        "path": "control.json",
                        "data": base64.b64encode(b"private-control").decode("ascii"),
                    }) + "\n")
                    child.stdin.flush()
                    self.assertTrue(json.loads(child.stdout.readline())["ok"])
                    os.killpg(child.pid, sent_signal)
                    child.wait(timeout=3)
                    deadline = time.monotonic() + 2
                    while (session / "control.json").exists() and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertFalse((session / "control.json").exists())
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=3)
                    child.stdin.close()
                    child.stdout.close()
                    child.stderr.close()


if __name__ == "__main__":
    unittest.main()
