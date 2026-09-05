"""Closed runtime evidence contracts; no host installs or real Store access."""

import contextlib
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from qa import runtime_launch_evidence as evidence


class RuntimeLaunchEvidenceTest(unittest.TestCase):
    def test_diagnostic_guide_is_outside_durable_replay_fixtures(self):
        root = Path(__file__).resolve().parents[1]
        guide = "docs/runtime-evidence/SKILL.md"
        self.assertTrue((root / guide).is_file())
        self.assertIn(guide, (root / "docs/runtime-support.md").read_text(encoding="utf-8"))
        self.assertEqual(list((root / "qa/fixtures").rglob("SKILL.md")), [])

    def observe(self, stdout=b"v22.0.0\n", stderr=b"", code=0, **options):
        return evidence.observe_runtime(
            runner=lambda _: subprocess.CompletedProcess("node", code, stdout, stderr),
            **options,
        )

    def test_candidate_never_certifies_host_or_launch(self):
        for host in evidence.HOSTS:
            for environment in evidence.ENVIRONMENTS:
                receipt = self.observe(host_claim=host, environment=environment)
                self.assertEqual(receipt["nodeVersion"], "22.0.0")
                self.assertEqual(receipt["nodeStatus"], "candidate")
                self.assertEqual(receipt["hostClaim"], host)
                self.assertEqual(receipt["environment"], environment)
                self.assertEqual(receipt["provenance"], "unverified-self-report")
                self.assertFalse(receipt["freshHostVerified"])
                self.assertEqual(receipt["launchMode"], "unresolved")

    def test_older_stable_version_is_visible_but_unsupported(self):
        receipt = self.observe(b"v20.19.0\r\n")
        self.assertTrue(receipt["nodeAvailable"])
        self.assertEqual(receipt["nodeVersion"], "20.19.0")
        self.assertEqual(receipt["nodeStatus"], "unsupported")

    def test_malformed_noisy_and_private_output_is_discarded(self):
        secret = b"/private/person/token-secret"
        for stdout, stderr in (
            (secret, b""), (b"v22.0.0\n" + secret, b""),
            (b"v22.0.0\n", secret), (b"v22.0.0-rc.1", b""),
            (b"v022.0.0", b""), (b"v9999.0.0", b""),
            (b"x" * 257, b""), (b"\xff", b""), ("v22.0.0", b""),
        ):
            receipt = self.observe(stdout, stderr)
            self.assertFalse(receipt["nodeAvailable"])
            self.assertIsNone(receipt["nodeVersion"])
            self.assertEqual(receipt["nodeStatus"], "invalid-output")
            self.assertNotIn("token-secret", json.dumps(receipt))

    def test_process_failures_have_closed_output(self):
        for error, status in (
            (FileNotFoundError("private path"), "unavailable"),
            (PermissionError("private path"), "unavailable"),
            (subprocess.TimeoutExpired("private path", 2), "timeout"),
            (ValueError("private bytes"), "invalid-output"),
        ):
            def fail(_):
                raise error
            receipt = evidence.observe_runtime(runner=fail)
            self.assertEqual(receipt["nodeStatus"], status)
            self.assertNotIn("private", json.dumps(receipt))
        self.assertEqual(self.observe(code=1)["nodeStatus"], "unavailable")

    def test_real_node_free_simulation_does_not_resolve_or_launch(self):
        with patch.object(evidence.shutil, "which") as lookup, patch.object(evidence.subprocess, "Popen") as launch:
            receipt = evidence.observe_runtime("node-free-simulation", "codex")
        lookup.assert_not_called()
        launch.assert_not_called()
        self.assertEqual(receipt["nodeStatus"], "unavailable")
        self.assertFalse(receipt["freshHostVerified"])

    def test_runner_is_bounded_and_excludes_preload_environment(self):
        process = unittest.mock.Mock()
        process.stdout = io.BytesIO(b"v22.1.0\n")
        process.stderr = io.BytesIO(b"")
        process.returncode = 0
        with patch.dict(evidence.os.environ, {"NODE_OPTIONS": "private", "NODE_PATH": "private", "HOME": "private"}), \
             patch.object(evidence.shutil, "which", return_value=sys.executable), \
             patch.object(evidence.subprocess, "Popen", return_value=process) as launch:
            result = evidence.run_version("inherited-path")
        self.assertEqual(result.stdout, b"v22.1.0\n")
        options = launch.call_args.kwargs
        self.assertFalse(options["shell"])
        self.assertEqual(launch.call_args.args[0][1:], ["--version"])
        self.assertTrue({"NODE_OPTIONS", "NODE_PATH", "HOME"}.isdisjoint(options["env"]))
        self.assertFalse(evidence.Path(options["cwd"]).exists())
        process.wait.assert_called_with(timeout=evidence.TIMEOUT_SECONDS)

    def test_runner_kills_on_output_overflow(self):
        process = unittest.mock.Mock()
        process.stdout = io.BytesIO(b"x" * 300)
        process.stderr = io.BytesIO(b"")
        process.returncode = 0
        with patch.object(evidence.shutil, "which", return_value=sys.executable), \
             patch.object(evidence.subprocess, "Popen", return_value=process):
            with self.assertRaises(ValueError):
                evidence.run_version("inherited-path")
        process.kill.assert_called_once()

    def test_cli_rejects_private_arguments_without_echo(self):
        output = io.StringIO()
        with patch.object(sys, "argv", ["evidence", "--host-claim", "private-token"]), contextlib.redirect_stderr(output):
            with self.assertRaises(SystemExit) as error:
                evidence.main()
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(output.getvalue(), "invalid runtime evidence arguments\n")

    def test_runner_reaps_timed_out_process_and_removes_temporary_directory(self):
        process = unittest.mock.Mock()
        process.stdout = io.BytesIO(b"")
        process.stderr = io.BytesIO(b"")
        process.wait.side_effect = [subprocess.TimeoutExpired("private", 2), 0]
        with patch.object(evidence.shutil, "which", return_value=sys.executable), \
             patch.object(evidence.subprocess, "Popen", return_value=process) as launch:
            receipt = evidence.observe_runtime()
        self.assertEqual(receipt["nodeStatus"], "timeout")
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)
        self.assertFalse(evidence.Path(launch.call_args.kwargs["cwd"]).exists())
        self.assertNotIn("private", json.dumps(receipt))

    def test_receipt_schema_is_exact(self):
        self.assertEqual(set(self.observe()), {
            "schemaVersion", "platform", "arch", "environment", "hostClaim",
            "provenance", "freshHostVerified", "nodeAvailable", "nodeVersion",
            "nodeStatus", "launchMode",
        })


if __name__ == "__main__":
    unittest.main()
