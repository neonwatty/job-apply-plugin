from tests.support.pdf_fixture import *
from tests.support.replay_case import *


class ReplayCoordinatorTests(ReplayCase):
    def test_cleanup_abandons_prepared_run_and_is_idempotent(self) -> None:
        output, run_root, _state = self.prepare()
        route = parse_qs(urlsplit(output["url"]).fragment)["qa-route"][0]

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(
            result,
            {"runId": run_root.name, "state": "abandoned", "reportRetained": False},
        )
        self.assertTrue((run_root / "store").is_dir())
        tombstone = json.loads((run_root / "tombstone.json").read_text())
        self.assertEqual(
            set(tombstone),
            {
                "runId",
                "state",
                "reportRetained",
                "lifecycleNonce",
                "fixtureId",
                "scenarioId",
                "reportSha256",
                "mac",
            },
        )
        self.assertEqual(
            {key: tombstone[key] for key in result},
            result,
        )
        for path in run_root.rglob("*"):
            if path.is_file() and path.name != "tombstone.json":
                self.assertEqual(path.stat().st_size, 0, path)
        with self.assertRaises((OSError, urllib.error.URLError)):
            urllib.request.urlopen(
                self.base_url(output["url"]) + "/__qa/state", timeout=1
            )
        self.server_cleanup = None
        self.assertEqual(
            self.invoke(["resolve", "--route-token", route]),
            (2, None, "unknown QA route\n"),
        )
        self.assertEqual(
            self.invoke(["evaluate", "--run-id", run_root.name]),
            (2, None, "invalid run state\n"),
        )
        self.assertEqual(
            self.invoke(["cleanup", "--run-id", run_root.name]),
            (0, result, ""),
        )

    def test_cleanup_preserves_shutdown_capability_when_server_is_unavailable(self) -> None:
        output, run_root, state = self.prepare()
        original_request = self.cli._authenticated_request

        def unavailable_identity(url, path, token, method="GET"):
            if path == "/__qa/identity":
                raise self.cli.CoordinatorError("fixture server unavailable")
            return original_request(url, path, token, method)

        with mock.patch.object(
            self.cli, "_authenticated_request", side_effect=unavailable_identity
        ):
            result = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(result, (2, None, "fixture server unavailable\n"))
        self.assertEqual(json.loads((run_root / "run.json").read_text()), state)
        self.assertFalse((run_root / "abandoned.json").exists())
        self.assertFalse((run_root / "tombstone.json").exists())
        with urllib.request.urlopen(
            self.base_url(output["url"]) + "/__qa/state", timeout=1
        ) as response:
            self.assertEqual(response.status, 200)

        code, cleanup, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, cleanup["state"], stderr), (0, "abandoned", ""))
        self.server_cleanup = None

    def test_cleanup_sanitizes_completed_synthetic_data_but_retains_report(self) -> None:
        output, run_root, _state = self.prepare()
        code, report, _stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual(code, 1)
        self.server_cleanup = None

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(result["state"], "completed")
        self.assertTrue(result["reportRetained"])
        self.assertEqual(json.loads((run_root / "report.json").read_text()), report)
        for path in run_root.rglob("*"):
            if path.is_file() and path.name not in {"report.json", "tombstone.json"}:
                self.assertEqual(path.stat().st_size, 0, path)

    def test_cleanup_never_stops_a_server_that_fails_run_authentication(self) -> None:
        output, run_root, _state = self.prepare()
        state_path = run_root / "run.json"
        state = json.loads(state_path.read_text())
        state["shutdownToken"] = "b" * 64
        state_path.write_text(json.dumps(state))
        os.chmod(state_path, 0o600)

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(
            (code, result, stderr),
            (2, None, "fixture server identity mismatch\n"),
        )
        with urllib.request.urlopen(
            self.base_url(output["url"]) + "/__qa/state", timeout=1
        ) as response:
            self.assertEqual(response.status, 200)

    def test_preplanted_tombstone_and_report_cannot_bypass_shutdown(self) -> None:
        output, run_root, _state = self.prepare()
        forged_tombstone = {
            "runId": run_root.name,
            "state": "completed",
            "reportRetained": True,
        }
        (run_root / "tombstone.json").write_text(json.dumps(forged_tombstone))
        (run_root / "report.json").write_text(
            json.dumps({"forged": "valuable report bytes"})
        )
        os.chmod(run_root / "tombstone.json", 0o600)
        os.chmod(run_root / "report.json", 0o600)

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
        self.assertFalse(result["reportRetained"])
        self.assertEqual((run_root / "report.json").stat().st_size, 0)
        with self.assertRaises((OSError, urllib.error.URLError)):
            urllib.request.urlopen(
                self.base_url(output["url"]) + "/__qa/state", timeout=1
            )
        self.server_cleanup = None

    def test_cleanup_directory_swap_at_open_preserves_replacement_bytes(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        store_opens = 0
        swapped = False

        def swap_before_open(path, flags, *args, **kwargs):
            nonlocal store_opens, swapped
            dir_fd = kwargs.get("dir_fd")
            if (
                path == "store"
                and flags & os.O_DIRECTORY
                and dir_fd is not None
            ):
                store_opens += 1
                if store_opens == 2 and not swapped:
                    swapped = True
                    os.rename(
                        path,
                        "attacker-original-store",
                        src_dir_fd=dir_fd,
                        dst_dir_fd=dir_fd,
                    )
                    os.mkdir(path, mode=0o700, dir_fd=dir_fd)
                    replacement = original_open(
                        f"{path}/valuable.bin",
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                        dir_fd=dir_fd,
                    )
                    os.write(replacement, b"valuable-open-replacement")
                    os.close(replacement)
            return original_open(path, flags, *args, **kwargs)

        with mock.patch.object(self.cli.os, "open", side_effect=swap_before_open):
            result = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(result, (2, None, "run cleanup failed\n"))
        self.assertEqual(
            (run_root / "store/valuable.bin").read_bytes(),
            b"valuable-open-replacement",
        )
        self.server_cleanup = None

    def test_cleanup_regular_last_boundary_swap_preserves_replacement(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        original_truncate = self.cli.os.ftruncate
        profile_descriptor = None
        swapped = False

        def remember_profile_open(path, flags, *args, **kwargs):
            nonlocal profile_descriptor
            descriptor = original_open(path, flags, *args, **kwargs)
            if path == "profile.json" and flags & os.O_WRONLY:
                profile_descriptor = descriptor
            return descriptor

        def swap_before_truncate(descriptor, size):
            nonlocal swapped
            if descriptor == profile_descriptor and not swapped:
                swapped = True
                dir_fd = os.open(run_root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.rename(
                        "profile.json",
                        "attacker-original-profile.json",
                        src_dir_fd=dir_fd,
                        dst_dir_fd=dir_fd,
                    )
                    replacement = original_open(
                        "profile.json",
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                        dir_fd=dir_fd,
                    )
                    os.write(replacement, b"valuable-last-boundary-replacement")
                    os.close(replacement)
                finally:
                    os.close(dir_fd)
            return original_truncate(descriptor, size)

        with mock.patch.object(
            self.cli.os, "open", side_effect=remember_profile_open
        ), mock.patch.object(
            self.cli.os, "ftruncate", side_effect=swap_before_truncate
        ):
            result = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(result, (2, None, "run cleanup failed\n"))
        self.assertTrue(swapped)
        self.assertEqual(
            (run_root / "profile.json").read_bytes(),
            b"valuable-last-boundary-replacement",
        )
        self.server_cleanup = None

    def test_cleanup_never_uses_pathname_deletion(self) -> None:
        _output, run_root, _state = self.prepare()

        with mock.patch.object(
            self.cli.os, "unlink", side_effect=AssertionError("unlink called")
        ), mock.patch.object(
            self.cli.os, "rmdir", side_effect=AssertionError("rmdir called")
        ):
            code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
        self.server_cleanup = None

    def test_cleanup_detects_a_new_entry_created_during_sanitizing(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        injected = False

        def inject_late_entry(path, flags, *args, **kwargs):
            nonlocal injected
            dir_fd = kwargs.get("dir_fd")
            descriptor = original_open(path, flags, *args, **kwargs)
            if path == "profile.json" and flags & os.O_WRONLY and not injected:
                injected = True
                late = original_open(
                    "late-value.bin",
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=dir_fd,
                )
                os.write(late, b"late-valuable-bytes")
                os.close(late)
            return descriptor

        with mock.patch.object(self.cli.os, "open", side_effect=inject_late_entry):
            result = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(result, (2, None, "run cleanup failed\n"))
        self.assertEqual(
            (run_root / "late-value.bin").read_bytes(), b"late-valuable-bytes"
        )
        self.server_cleanup = None

    def test_cleanup_retries_after_interrupted_abandoned_marker_temp(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        original_write = self.cli.os.write
        marker_descriptor = None
        interrupted = False

        def remember_marker(path, flags, *args, **kwargs):
            nonlocal marker_descriptor
            descriptor = original_open(path, flags, *args, **kwargs)
            if isinstance(path, str) and path.startswith(".marker-abandoned-"):
                marker_descriptor = descriptor
            return descriptor

        def short_write(descriptor, data):
            nonlocal interrupted
            if descriptor == marker_descriptor and not interrupted:
                interrupted = True
                original_write(descriptor, data[:3])
                raise OSError("disk full")
            return original_write(descriptor, data)

        with mock.patch.object(
            self.cli.os, "open", side_effect=remember_marker
        ), mock.patch.object(self.cli.os, "write", side_effect=short_write):
            first = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(first, (2, None, "run artifact write failed\n"))
        temps = list(run_root.glob(".marker-abandoned-*.tmp"))
        self.assertEqual(len(temps), 1)
        self.assertGreater(temps[0].stat().st_size, 0)
        with mock.patch.object(
            self.cli.os, "unlink", side_effect=AssertionError("unlink called")
        ), mock.patch.object(
            self.cli.os, "rmdir", side_effect=AssertionError("rmdir called")
        ):
            code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
        self.assertEqual(temps[0].stat().st_size, 0)
        self.server_cleanup = None

    def test_cleanup_retries_after_interrupted_tombstone_marker_temp(self) -> None:
        _output, run_root, _state = self.prepare()
        original_open = self.cli.os.open
        original_write = self.cli.os.write
        marker_descriptor = None
        interrupted = False

        def remember_marker(path, flags, *args, **kwargs):
            nonlocal marker_descriptor
            descriptor = original_open(path, flags, *args, **kwargs)
            if isinstance(path, str) and path.startswith(".marker-tombstone-"):
                marker_descriptor = descriptor
            return descriptor

        def fail_tombstone(descriptor, data):
            nonlocal interrupted
            if descriptor == marker_descriptor and not interrupted:
                interrupted = True
                original_write(descriptor, data[:5])
                raise OSError("disk full")
            return original_write(descriptor, data)

        with mock.patch.object(
            self.cli.os, "open", side_effect=remember_marker
        ), mock.patch.object(self.cli.os, "write", side_effect=fail_tombstone):
            first = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual(first, (2, None, "run artifact write failed\n"))
        temps = list(run_root.glob(".marker-tombstone-*.tmp"))
        self.assertEqual(len(temps), 1)
        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
        self.assertEqual(temps[0].stat().st_size, 0)
        self.server_cleanup = None

    def test_cleanup_reconstructs_partial_final_markers_from_anchored_state(self) -> None:
        for marker_name in ("abandoned.json", "tombstone.json"):
            with self.subTest(marker_name=marker_name):
                _output, run_root, _state = self.prepare()
                marker = run_root / marker_name
                marker.write_bytes(b'{"state":')
                os.chmod(marker, 0o600)

                code, result, stderr = self.invoke(
                    ["cleanup", "--run-id", run_root.name]
                )

                self.assertEqual((code, result["state"], stderr), (0, "abandoned", ""))
                stored = json.loads((run_root / "tombstone.json").read_text())
                self.assertEqual({key: stored[key] for key in result}, result)
                for path in run_root.glob(".marker-*.tmp"):
                    self.assertEqual(path.stat().st_size, 0)
                self.server_cleanup = None

    def test_cleanup_recovers_after_every_sanitization_interruption(self) -> None:
        _probe_output, probe_root, _state = self.prepare()
        existing_regulars = sum(path.is_file() for path in probe_root.rglob("*"))
        self.invoke(["cleanup", "--run-id", probe_root.name])
        self.server_cleanup = None
        phases = existing_regulars + 2  # abandoned marker and evaluate lock
        self.assertGreater(phases, 3)

        for interrupt_after in range(1, phases + 1):
            with self.subTest(interrupt_after=interrupt_after):
                _output, run_root, _state = self.prepare()
                original_truncate = self.cli.os.ftruncate
                truncations = 0

                def interrupt_after_write(descriptor, size):
                    nonlocal truncations
                    truncations += 1
                    result = original_truncate(descriptor, size)
                    if truncations == interrupt_after:
                        raise OSError("interrupted sanitization")
                    return result

                with mock.patch.object(
                    self.cli.os, "ftruncate", side_effect=interrupt_after_write
                ):
                    first = self.invoke(["cleanup", "--run-id", run_root.name])

                self.assertEqual(first, (2, None, "run cleanup failed\n"))
                code, result, stderr = self.invoke(
                    ["cleanup", "--run-id", run_root.name]
                )
                self.assertEqual(
                    (code, result["state"], stderr), (0, "abandoned", "")
                )
                for path in run_root.rglob("*"):
                    if path.is_file() and path.name != "tombstone.json":
                        self.assertEqual(path.stat().st_size, 0, path)
                self.server_cleanup = None
