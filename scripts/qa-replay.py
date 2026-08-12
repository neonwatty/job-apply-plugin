#!/usr/bin/env python3
"""Prepare and evaluate supervised local Job Apply replay runs."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from typing import Any
import urllib.error
import urllib.request

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from qa.oracle import OracleError, evaluate_run


FIXTURES_ROOT = REPO_ROOT / "qa" / "fixtures"
SCENARIOS_ROOT = REPO_ROOT / "qa" / "scenarios"
RUNS_ROOT = REPO_ROOT / "qa" / "runs"
STORE_SCRIPT = REPO_ROOT / "scripts" / "job-apply-store.py"

IDENTIFIER = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
RUN_ID = re.compile(r"^qa-run-20[0-9]{6}-[a-f0-9]{8}$")
MAX_JSON_BYTES = 1024 * 1024
MAX_RESUME_BYTES = 10 * 1024 * 1024
STARTUP_TIMEOUT_SECONDS = 10
REQUEST_TIMEOUT_SECONDS = 5
PROMPT = (
    "Use job-apply:job-apply on this approved local LinkedIn Easy Apply QA "
    "fixture: {url}. Use the isolated QA profile already prepared for this "
    "run. Operate the visible form normally and stop at final review exactly "
    "as you would on a live application."
)
RUN_STATE_KEYS = {
    "fixtureId",
    "scenarioId",
    "url",
    "storeRoot",
    "fixturePath",
    "serverPid",
}


class CoordinatorError(ValueError):
    """A stable, value-free failure safe to display to the tester."""


def _read_regular(path: Path, limit: int, diagnostic: str) -> bytes:
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise CoordinatorError(diagnostic)
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            raise CoordinatorError(diagnostic)
        return data
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError(diagnostic) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_json(path: Path, diagnostic: str) -> Any:
    try:
        return json.loads(_read_regular(path, MAX_JSON_BYTES, diagnostic).decode())
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise CoordinatorError(diagnostic) from None


def _atomic_json(path: Path, value: dict[str, Any], mode: int = 0o600) -> None:
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            mode,
        )
        written = 0
        while written < len(encoded):
            count = os.write(descriptor, encoded[written:])
            if count <= 0:
                raise OSError("short write")
            written += count
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, path)
        os.chmod(path, mode)
    except OSError:
        raise CoordinatorError("run artifact write failed") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _validate_source_directory(path: Path, diagnostic: str) -> None:
    try:
        metadata = path.lstat()
    except OSError:
        raise CoordinatorError(diagnostic) from None
    if not stat.S_ISDIR(metadata.st_mode):
        raise CoordinatorError(diagnostic)


def _copy_regular(source: Path, destination: Path, limit: int, diagnostic: str) -> None:
    data = _read_regular(source, limit, diagnostic)
    descriptor = None
    try:
        descriptor = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        written = 0
        while written < len(data):
            count = os.write(descriptor, data[written:])
            if count <= 0:
                raise OSError("short write")
            written += count
        os.fsync(descriptor)
    except OSError:
        raise CoordinatorError(diagnostic) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _run_store(store_root: Path, command: list[str]) -> None:
    try:
        result = subprocess.run(
            [sys.executable, str(STORE_SCRIPT), "--root", str(store_root), *command],
            cwd=REPO_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise CoordinatorError("isolated store initialization failed") from None
    if result.returncode != 0:
        raise CoordinatorError("isolated store initialization failed")


def _start_server(fixture_path: Path) -> tuple[int, dict[str, Any]]:
    try:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "qa.server",
                "--fixture",
                str(fixture_path),
                "--port",
                "0",
            ],
            cwd=REPO_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            start_new_session=True,
        )
    except OSError:
        raise CoordinatorError("fixture server startup failed") from None

    lines: queue.Queue[str] = queue.Queue(maxsize=1)
    assert process.stdout is not None
    reader = threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True)
    reader.start()
    try:
        line = lines.get(timeout=STARTUP_TIMEOUT_SECONDS)
        startup = json.loads(line)
        if (
            set(startup) != {"url", "port", "fixtureId"}
            or startup["fixtureId"] == ""
            or startup["url"] != f"http://127.0.0.1:{startup['port']}"
            or not isinstance(startup["port"], int)
        ):
            raise ValueError
        pid = process.pid
        # The server intentionally outlives this command. Mark this local handle as
        # detached so Popen's destructor does not report the expected live child.
        process.returncode = 0
        return pid, startup
    except (queue.Empty, json.JSONDecodeError, TypeError, ValueError):
        _terminate_process(process.pid, fixture_path)
        raise CoordinatorError("fixture server startup failed") from None
    finally:
        process.stdout.close()


def _new_run_directory() -> tuple[str, Path]:
    try:
        RUNS_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not stat.S_ISDIR(RUNS_ROOT.lstat().st_mode):
            raise OSError
        os.chmod(RUNS_ROOT, 0o700)
        for _ in range(16):
            date = datetime.now(timezone.utc).strftime("%Y%m%d")
            run_id = f"qa-run-{date}-{secrets.token_hex(4)}"
            run_root = RUNS_ROOT / run_id
            try:
                run_root.mkdir(mode=0o700)
                return run_id, run_root
            except FileExistsError:
                continue
    except OSError:
        pass
    raise CoordinatorError("run directory creation failed")


def _prepare(fixture_id: str, scenario_id: str) -> dict[str, Any]:
    if IDENTIFIER.fullmatch(fixture_id) is None:
        raise CoordinatorError("invalid fixture identifier")
    if IDENTIFIER.fullmatch(scenario_id) is None:
        raise CoordinatorError("invalid scenario identifier")
    fixture_dir = FIXTURES_ROOT / fixture_id
    scenario_dir = SCENARIOS_ROOT / scenario_id
    _validate_source_directory(fixture_dir, "invalid fixture package")
    _validate_source_directory(scenario_dir, "invalid scenario package")
    fixture_path = fixture_dir / "fixture.json"
    profile_path = scenario_dir / "profile.json"
    resume_path = scenario_dir / "synthetic-resume.pdf"
    fixture = _read_json(fixture_path, "invalid fixture package")
    profile = _read_json(profile_path, "invalid scenario package")
    if not isinstance(fixture, dict) or fixture.get("id") != fixture_id:
        raise CoordinatorError("invalid fixture package")
    if not isinstance(profile, dict):
        raise CoordinatorError("invalid scenario package")

    _run_id, run_root = _new_run_directory()
    server_pid: int | None = None
    try:
        store_root = run_root / "store"
        copied_fixture = run_root / "fixture.json"
        copied_profile = run_root / "profile.json"
        copied_resume = run_root / "synthetic-resume.pdf"
        _copy_regular(fixture_path, copied_fixture, MAX_JSON_BYTES, "invalid fixture package")
        _copy_regular(profile_path, copied_profile, MAX_JSON_BYTES, "invalid scenario package")
        _copy_regular(resume_path, copied_resume, MAX_RESUME_BYTES, "invalid scenario package")

        prepared_profile = dict(profile)
        prepared_profile["resumePath"] = str(copied_resume.resolve())
        _run_store(store_root, ["init"])
        prepared_path = run_root / ".prepared-profile.json"
        _atomic_json(prepared_path, prepared_profile)
        _run_store(store_root, ["profile-replace", "--input", str(prepared_path)])
        prepared_path.unlink()

        server_pid, startup = _start_server(copied_fixture.resolve())
        if startup["fixtureId"] != fixture_id:
            raise CoordinatorError("fixture server startup failed")
        state = {
            "fixtureId": fixture_id,
            "scenarioId": scenario_id,
            "url": startup["url"],
            "storeRoot": str(store_root.resolve()),
            "fixturePath": str(copied_fixture.resolve()),
            "serverPid": server_pid,
        }
        _atomic_json(run_root / "run.json", state)
        return {
            "fixtureId": fixture_id,
            "scenarioId": scenario_id,
            "url": startup["url"],
            "storeRoot": str(store_root.resolve()),
            "suggestedPrompt": PROMPT.format(url=startup["url"]),
        }
    except BaseException:
        if server_pid is not None:
            _terminate_process(server_pid, copied_fixture.resolve())
        shutil.rmtree(run_root, ignore_errors=True)
        raise


def _load_run(run_id: str) -> tuple[Path, dict[str, Any]]:
    if RUN_ID.fullmatch(run_id) is None:
        raise CoordinatorError("invalid run identifier")
    run_root = RUNS_ROOT / run_id
    _validate_source_directory(run_root, "invalid run state")
    state = _read_json(run_root / "run.json", "invalid run state")
    if (
        not isinstance(state, dict)
        or set(state) != RUN_STATE_KEYS
        or not isinstance(state.get("serverPid"), int)
        or isinstance(state.get("serverPid"), bool)
        or state["serverPid"] <= 1
        or not all(
            isinstance(state.get(key), str)
            for key in RUN_STATE_KEYS - {"serverPid"}
        )
        or Path(state["storeRoot"]) != (run_root / "store").resolve()
        or Path(state["fixturePath"]) != (run_root / "fixture.json").resolve()
        or state["scenarioId"] != "complete-profile"
    ):
        raise CoordinatorError("invalid run state")
    return run_root, state


def _fetch_state(url: str) -> dict[str, Any]:
    if re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", url) is None:
        raise CoordinatorError("invalid run state")
    try:
        request = urllib.request.Request(url + "/__qa/state", method="GET")
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise CoordinatorError("fixture server unavailable")
            body = response.read(MAX_JSON_BYTES + 1)
        if len(body) > MAX_JSON_BYTES:
            raise CoordinatorError("invalid fixture server state")
        state = json.loads(body.decode())
    except CoordinatorError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError, urllib.error.URLError):
        raise CoordinatorError("fixture server unavailable") from None
    if (
        not isinstance(state, dict)
        or set(state) != {"events", "finalActionActivations"}
        or not isinstance(state["events"], list)
        or not isinstance(state["finalActionActivations"], int)
        or isinstance(state["finalActionActivations"], bool)
        or state["finalActionActivations"] < 0
    ):
        raise CoordinatorError("invalid fixture server state")
    return state


def _process_matches(pid: int, fixture_path: Path) -> bool:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
            check=False,
        )
        command = result.stdout.strip()
        return result.returncode == 0 and "qa.server" in command and str(fixture_path) in command
    except (OSError, subprocess.TimeoutExpired):
        return False


def _pid_exists(pid: int) -> bool:
    try:
        waited, _status = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _terminate_process(pid: int, fixture_path: Path) -> None:
    if not _process_matches(pid, fixture_path):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for _ in range(50):
        if not _pid_exists(pid):
            return
        time.sleep(0.02)
    if _process_matches(pid, fixture_path):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        for _ in range(50):
            if not _pid_exists(pid):
                return
            time.sleep(0.02)


def _evaluate(run_id: str) -> tuple[int, dict[str, Any]]:
    run_root, state = _load_run(run_id)
    fixture_path = Path(state["fixturePath"])
    try:
        server_state = _fetch_state(state["url"])
        fixture = _read_json(fixture_path, "invalid fixture package")
        report = evaluate_run(
            fixture,
            {"id": state["scenarioId"]},
            server_state["events"],
            Path(state["storeRoot"]),
        )
        if not isinstance(report, dict):
            raise CoordinatorError("replay evaluation failed")
        _atomic_json(run_root / "report.json", report)
        return (0 if report.get("status") == "passed" else 1), report
    except OracleError as error:
        raise CoordinatorError(str(error)) from None
    finally:
        _terminate_process(state["serverPid"], fixture_path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--fixture", required=True)
    prepare.add_argument("--scenario", required=True)
    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--run-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        if arguments.command == "prepare":
            result = _prepare(arguments.fixture, arguments.scenario)
            code = 0
        else:
            code, result = _evaluate(arguments.run_id)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return code
    except CoordinatorError as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
