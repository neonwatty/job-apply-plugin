import json
import os
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import http.client
import importlib.util
import io
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[2]
LAUNCHER = REPO / "scripts" / "qa-chrome.py"
LAUNCHER_SPEC = importlib.util.spec_from_file_location("qa_chrome_launcher", LAUNCHER)
LAUNCHER_MODULE = importlib.util.module_from_spec(LAUNCHER_SPEC)
LAUNCHER_SPEC.loader.exec_module(LAUNCHER_MODULE)


class ChromeLauncherCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir(mode=0o700)
        self.fake = Path(self.tmp.name) / "fake chrome"
        self.signal_log = Path(self.tmp.name) / "signals.log"
        self.launch_log = Path(self.tmp.name) / "launches.log"
        self.fake.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import http.server, os, signal, socketserver, sys, threading, time
                user_dir = next(a.split('=', 1)[1] for a in sys.argv if a.startswith('--user-data-dir='))
                launch_log = os.environ.get('SYNTHETIC_LAUNCH_LOG')
                if launch_log: open(launch_log, 'a').write('launched\\n')
                class Handler(http.server.BaseHTTPRequestHandler):
                    def do_GET(self):
                        if self.path != '/json/version':
                            self.send_error(404); return
                        body = ('{"Browser":"Synthetic","Protocol-Version":"1.3",'
                                '"webSocketDebuggerUrl":"ws://127.0.0.1:%d/devtools/browser/synthetic"}'
                                % self.server.server_address[1]).encode('ascii')
                        self.send_response(200); self.send_header('Content-Type', 'application/json')
                        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
                    def log_message(self, *args): pass
                requested_port = int(next(a.split('=', 1)[1] for a in sys.argv if a.startswith('--remote-debugging-port=')))
                server = socketserver.TCPServer(('127.0.0.1', requested_port), Handler)
                port = server.server_address[1]
                open(os.path.join(user_dir, 'DevToolsActivePort'), 'w').write(str(port) + '\\n/devtools/browser/synthetic\\n')
                log = os.environ.get('SYNTHETIC_SIGNAL_LOG')
                def stop(signum, frame):
                    if log: open(log, 'a').write(str(signum) + '\\n')
                    threading.Thread(target=server.shutdown, daemon=True).start()
                signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
                server.serve_forever()
                """
            )
        )
        self.fake.chmod(0o700)
        self.env = os.environ.copy()
        self.env.update(
            HOME=str(self.home),
            SYNTHETIC_SIGNAL_LOG=str(self.signal_log),
            SYNTHETIC_LAUNCH_LOG=str(self.launch_log),
        )

    def tearDown(self):
        try:
            self.run_cli("stop", "--profile", "linkedin-capture", timeout=3)
        except Exception:
            pass
        self.tmp.cleanup()

    def run_cli(self, *args, timeout=8):
        return subprocess.run(
            [sys.executable, str(LAUNCHER), *args],
            text=True,
            capture_output=True,
            env=self.env,
            timeout=timeout,
        )

    def start(self, profile="linkedin-capture", timeout=12):
        return self.run_cli("start", "--profile", profile, "--chrome-path", str(self.fake), timeout=timeout)

    def assert_closed(self, result, keys):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(json.loads(result.stdout)), set(keys))
        self.assertEqual(result.stderr, "")

    def metadata_snapshot(self):
        paths = [self.home]
        for parent, directories, files in os.walk(self.home, followlinks=False):
            base = Path(parent)
            paths.extend(base / name for name in directories)
            paths.extend(base / name for name in files)
        snapshot = {}
        for path in sorted(set(paths)):
            value = path.lstat()
            snapshot[str(path.relative_to(self.home))] = (
                value.st_mode,
                value.st_uid,
                value.st_gid,
                value.st_dev,
                value.st_ino,
                value.st_nlink,
                value.st_size,
                value.st_atime_ns,
                value.st_mtime_ns,
                value.st_ctime_ns,
            )
        return snapshot

    def assert_reset_uses_readonly_observation(self, profile, expected_error=None):
        real_open = os.open
        profile_identity = (
            self.home / ".job-apply-qa" / "chrome-profiles" / profile
        ).stat()

        def readonly_open(path, flags, *args, **kwargs):
            forbidden = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC
            self.assertEqual(flags & forbidden, 0, "reset opened managed state for writing")
            parent_fd = kwargs.get("dir_fd")
            if parent_fd is not None:
                parent = os.fstat(parent_fd)
                self.assertNotEqual(
                    (parent.st_dev, parent.st_ino),
                    (profile_identity.st_dev, profile_identity.st_ino),
                    "reset inspected Chrome profile contents",
                )
            return real_open(path, flags, *args, **kwargs)

        def forbidden_mutation(*_args, **_kwargs):
            self.fail("reset attempted a filesystem mutation")

        def forbidden_data_read(*_args, **_kwargs):
            self.fail("reset read managed file contents")

        output = io.StringIO()
        mutations = ("mkdir", "write", "pwrite", "ftruncate", "rename", "replace", "unlink", "remove", "chmod")
        patches = [mock.patch.object(LAUNCHER_MODULE.os, name, side_effect=forbidden_mutation) for name in mutations]
        patches.extend([
            mock.patch.object(LAUNCHER_MODULE.os, "open", side_effect=readonly_open),
            mock.patch.object(LAUNCHER_MODULE.os, "read", side_effect=forbidden_data_read),
            mock.patch.object(LAUNCHER_MODULE.os, "pread", side_effect=forbidden_data_read),
            mock.patch.object(LAUNCHER_MODULE.sys, "stdout", output),
        ])
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}):
            with ExitStack() as stack:
                for patcher in patches:
                    stack.enter_context(patcher)
                if expected_error is None:
                    LAUNCHER_MODULE.command_reset(profile)
                else:
                    with self.assertRaisesRegex(LAUNCHER_MODULE.UserError, expected_error):
                        LAUNCHER_MODULE.command_reset(profile)
        return output.getvalue()
