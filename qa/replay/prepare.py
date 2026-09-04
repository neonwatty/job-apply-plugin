"""Preparation of isolated descriptor-bound replay runs."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from typing import Any

from qa.contracts import ContractError, validate_fixture
from qa.replay.cleanup import _remove_contents_at
from qa.replay.report import SCENARIO_IDS
from qa.replay.run_state import (
    FIXTURES_ROOT,
    REPO_ROOT,
    SCENARIOS_ROOT,
    STORE_SCRIPT,
    _new_run_directory,
)
from qa.replay.secure_io import (
    CoordinatorError,
    MAX_JSON_BYTES,
    MAX_RESUME_BYTES,
    _RunStorage,
    _atomic_json_at,
    _verify_directory_binding,
)
from qa.replay.server_control import _shutdown_server, _start_server


IDENTIFIER = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
EXPECTED_KEYS = {"controlIds", "resumeFilename"}
PROMPT = (
    "Use job-apply:job-apply on this approved local {platform} QA "
    "fixture: {url}. Use the isolated QA profile already prepared for this "
    "run. Operate the visible form normally and stop at final review exactly "
    "as you would on a live application."
)
PLATFORM_LABELS = {
    "ashby": "Ashby",
    "greenhouse": "Greenhouse",
    "lever": "Lever",
    "linkedin-easy-apply": "LinkedIn Easy Apply",
}


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _read_regular(
    path: Path,
    limit: int,
    diagnostic: str,
    *,
    _runtime: Any | None = None,
) -> bytes:
    runtime = _resolve_runtime(_runtime)
    descriptor = None
    try:
        descriptor = runtime.os.open(
            path, runtime.os.O_RDONLY | getattr(runtime.os, "O_NOFOLLOW", 0)
        )
        metadata = runtime.os.fstat(descriptor)
        if not runtime.stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise CoordinatorError(diagnostic)
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = runtime.os.read(descriptor, min(64 * 1024, remaining))
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
            runtime.os.close(descriptor)


def _read_json(
    path: Path, diagnostic: str, *, _runtime: Any | None = None
) -> Any:
    runtime = _resolve_runtime(_runtime)
    try:
        return runtime.json.loads(
            runtime._read_regular(
                path, runtime.MAX_JSON_BYTES, diagnostic
            ).decode()
        )
    except (UnicodeError, runtime.json.JSONDecodeError, RecursionError):
        raise CoordinatorError(diagnostic) from None


def _validate_source_directory(
    path: Path, diagnostic: str, *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        metadata = path.lstat()
    except OSError:
        raise CoordinatorError(diagnostic) from None
    if not runtime.stat.S_ISDIR(metadata.st_mode):
        raise CoordinatorError(diagnostic)


def _copy_regular_at(
    source: Path,
    directory_descriptor: int,
    name: str,
    limit: int,
    diagnostic: str,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    data = runtime._read_regular(source, limit, diagnostic)
    descriptor = None
    try:
        descriptor = runtime.os.open(
            name,
            runtime.os.O_WRONLY
            | runtime.os.O_CREAT
            | runtime.os.O_EXCL
            | getattr(runtime.os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_descriptor,
        )
        runtime.os.fchmod(descriptor, 0o600)
        view = memoryview(data)
        while view:
            count = runtime.os.write(descriptor, view)
            if count <= 0:
                raise OSError
            view = view[count:]
        runtime.os.fsync(descriptor)
    except OSError:
        raise CoordinatorError(diagnostic) from None
    finally:
        if descriptor is not None:
            runtime.os.close(descriptor)


def _run_store_json(
    store_root: Path,
    command: list[str],
    *,
    _runtime: Any | None = None,
) -> Any:
    runtime = _resolve_runtime(_runtime)
    disabled_legacy = store_root.parent / ".legacy-profile-disabled.json"
    try:
        result = runtime.subprocess.run(
            [
                runtime.sys.executable,
                str(runtime.STORE_SCRIPT),
                "--root",
                str(store_root),
                "--legacy-profile",
                str(disabled_legacy),
                *command,
            ],
            cwd=runtime.REPO_ROOT,
            stdin=runtime.subprocess.DEVNULL,
            stdout=runtime.subprocess.PIPE,
            stderr=runtime.subprocess.DEVNULL,
            timeout=15,
            check=False,
        )
    except (OSError, runtime.subprocess.TimeoutExpired):
        raise CoordinatorError("isolated store initialization failed") from None
    if result.returncode != 0:
        raise CoordinatorError("isolated store initialization failed")
    try:
        return runtime.json.loads(result.stdout)
    except (TypeError, runtime.json.JSONDecodeError):
        raise CoordinatorError("isolated store initialization failed") from None


def _run_store(
    store_root: Path,
    command: list[str],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    runtime._run_store_json(store_root, command)


def _prepare(
    fixture_id: str,
    scenario_id: str,
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    if runtime.IDENTIFIER.fullmatch(fixture_id) is None:
        raise CoordinatorError("invalid fixture identifier")
    if runtime.IDENTIFIER.fullmatch(scenario_id) is None:
        raise CoordinatorError("invalid scenario identifier")
    if scenario_id not in runtime.SCENARIO_IDS:
        raise CoordinatorError("invalid scenario identifier")
    fixture_dir = runtime.FIXTURES_ROOT / fixture_id
    scenario_dir = runtime.SCENARIOS_ROOT / scenario_id
    runtime._validate_source_directory(fixture_dir, "invalid fixture package")
    runtime._validate_source_directory(scenario_dir, "invalid scenario package")
    fixture_path = fixture_dir / "fixture.json"
    profile_path = scenario_dir / "profile.json"
    resume_path = scenario_dir / "synthetic-resume.pdf"
    expected_path = scenario_dir / "expected.json"
    fixture = runtime._read_json(fixture_path, "invalid fixture package")
    profile = runtime._read_json(profile_path, "invalid scenario package")
    expected = runtime._read_json(expected_path, "invalid scenario package")
    try:
        runtime.validate_fixture(fixture)
    except (ContractError, TypeError):
        raise CoordinatorError("invalid fixture package") from None
    if fixture.get("id") != fixture_id:
        raise CoordinatorError("invalid fixture package")
    if fixture.get("platformFamily") not in runtime.PLATFORM_LABELS:
        raise CoordinatorError("unsupported fixture platform")
    if not isinstance(profile, dict):
        raise CoordinatorError("invalid scenario package")
    fixture_control_ids = [
        control["id"]
        for step in fixture.get("steps", [])
        for control in step.get("controls", [])
    ]
    if (
        not isinstance(expected, dict)
        or set(expected) != runtime.EXPECTED_KEYS
        or expected.get("controlIds") != fixture_control_ids
        or expected.get("resumeFilename") != "synthetic-resume.pdf"
    ):
        raise CoordinatorError("invalid scenario package")

    run_id, run_root, root_descriptor, run_descriptor = (
        runtime._new_run_directory()
    )
    storage = _RunStorage.adopt_legacy(
        run_id,
        run_root,
        root_descriptor,
        run_descriptor,
    )
    startup: dict[str, Any] | None = None
    shutdown_token = runtime.secrets.token_hex(32)
    route_token = runtime.secrets.token_hex(32)
    try:
        runtime._verify_directory_binding(
            storage.run_root, storage.run_descriptor, "run directory changed"
        )
        store_root = storage.run_root / "store"
        copied_fixture = storage.run_root / "fixture.json"
        copied_resume = storage.run_root / "synthetic-resume.pdf"
        runtime._copy_regular_at(
            fixture_path,
            storage.run_descriptor,
            "fixture.json",
            runtime.MAX_JSON_BYTES,
            "invalid fixture package",
        )
        runtime._copy_regular_at(
            profile_path,
            storage.run_descriptor,
            "profile.json",
            runtime.MAX_JSON_BYTES,
            "invalid scenario package",
        )
        runtime._copy_regular_at(
            resume_path,
            storage.run_descriptor,
            "synthetic-resume.pdf",
            runtime.MAX_RESUME_BYTES,
            "invalid scenario package",
        )
        runtime._copy_regular_at(
            expected_path,
            storage.run_descriptor,
            "expected.json",
            runtime.MAX_JSON_BYTES,
            "invalid scenario package",
        )

        prepared_profile = dict(profile)
        prepared_profile["resumePath"] = str(copied_resume.resolve())
        runtime._run_store(store_root, ["init"])
        profile_inspection = runtime._run_store_json(
            store_root, ["profile-inspect"]
        )
        expected_revision = (
            profile_inspection.get("revision")
            if isinstance(profile_inspection, dict)
            else None
        )
        if (
            not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
        ):
            raise CoordinatorError("isolated store initialization failed")
        runtime._verify_directory_binding(
            storage.run_root, storage.run_descriptor, "run directory changed"
        )
        prepared_path = storage.run_root / ".prepared-profile.json"
        runtime._atomic_json_at(
            storage.run_descriptor, ".prepared-profile.json", prepared_profile
        )
        runtime._run_store(
            store_root,
            [
                "profile-replace",
                "--input",
                str(prepared_path),
                "--expected-revision",
                str(expected_revision),
                "--source",
                "resume",
            ],
        )
        runtime._verify_directory_binding(
            storage.run_root, storage.run_descriptor, "run directory changed"
        )
        runtime.os.unlink(".prepared-profile.json", dir_fd=storage.run_descriptor)

        startup = runtime._start_server(
            copied_fixture.resolve(), expected["resumeFilename"], shutdown_token
        )
        runtime._verify_directory_binding(
            storage.run_root, storage.run_descriptor, "run directory changed"
        )
        if startup["fixtureId"] != fixture_id:
            raise CoordinatorError("fixture server startup failed")
        state = {
            "fixtureId": fixture_id,
            "scenarioId": scenario_id,
            "url": startup["url"],
            "storeRoot": str(store_root.resolve()),
            "fixturePath": str(copied_fixture.resolve()),
            "routeToken": route_token,
            "shutdownToken": shutdown_token,
            "lifecycleNonce": runtime.secrets.token_hex(32),
            "createdAt": runtime.datetime.now(runtime.timezone.utc).isoformat(),
        }
        runtime._atomic_json_at(storage.run_descriptor, "run.json", state)
        runtime._atomic_json_at(
            storage.run_descriptor,
            "lifecycle.json",
            {"state": "prepared", "nonce": state["lifecycleNonce"]},
        )
        route_url = f'{startup["url"]}#qa-route={storage.run_id}.{route_token}'
        return {
            "fixtureId": fixture_id,
            "scenarioId": scenario_id,
            "url": route_url,
            "storeRoot": str(store_root.resolve()),
            "suggestedPrompt": runtime.PROMPT.format(
                platform=runtime.PLATFORM_LABELS[fixture["platformFamily"]],
                url=route_url,
            ),
        }
    except BaseException:
        if startup is not None:
            runtime._shutdown_server(
                startup["url"], shutdown_token, required=False
            )
        try:
            runtime._remove_contents_at(storage.run_descriptor)
            storage.close_run()
            runtime.os.rmdir(storage.run_id, dir_fd=storage.root_descriptor)
            runtime.os.fsync(storage.root_descriptor)
        except (CoordinatorError, OSError):
            pass
        raise
    finally:
        storage.close()
