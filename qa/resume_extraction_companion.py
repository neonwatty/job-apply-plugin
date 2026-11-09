"""Workspace and loopback companion primitives for resume onboarding QA."""

from __future__ import annotations

import base64
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURE = Path("qa/testdata/resumes/owner-like-redacted.pdf")
EXPECTED_FIXTURE_SHA256 = "aa5db02218f2eb40ab26521fb614b8bc86527fa11ee1c531b5555f6b54aad551"
STORE_SCRIPT = ROOT / "scripts" / "job-apply-store.py"
WORKSPACE_SCRIPT = ROOT / "scripts" / "job-apply-workspace.py"
RECEIPT_KEYS = (
    "requestShared",
    "autofillObserved",
    "conflictsReviewed",
    "profileShared",
    "contentChangeStaled",
    "racesRejected",
    "privacyVerified",
    "agentStoppedAtReview",
    "passed",
)


class OracleFailure(RuntimeError):
    pass


def _load_workspace() -> Any:
    spec = importlib.util.spec_from_file_location(
        "resume_onboarding_workspace", WORKSPACE_SCRIPT
    )
    if spec is None or spec.loader is None:
        raise OracleFailure("workspace unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


WORKSPACE = _load_workspace()
STORE = WORKSPACE.STORE_MODULE


def _require(condition: bool) -> None:
    if not condition:
        raise OracleFailure("oracle assertion failed")


def _fixture_path(raw: str) -> Path:
    supplied = Path(raw)
    if supplied.is_absolute() or ".." in supplied.parts:
        raise OracleFailure("fixture boundary rejected")
    if supplied.as_posix() != DEFAULT_FIXTURE.as_posix():
        raise OracleFailure("fixture boundary rejected")
    resolved = (ROOT / supplied).resolve(strict=True)
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError:
        raise OracleFailure("fixture boundary rejected") from None
    return resolved


def _store_path(raw: str) -> Path:
    root = Path(raw).resolve(strict=False)
    temporary_root = Path(tempfile.gettempdir()).resolve(strict=True)
    try:
        relative = root.relative_to(temporary_root)
    except ValueError:
        raise OracleFailure("store boundary rejected") from None
    if not relative.parts or root == temporary_root:
        raise OracleFailure("store boundary rejected")
    if root.exists() and (not root.is_dir() or any(root.iterdir())):
        raise OracleFailure("store boundary rejected")
    return root


class Companion:
    def __init__(self, root: Path, logs: io.StringIO):
        self.server = WORKSPACE.WorkspaceServer(root, 0, token="oracle-token")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.logs = logs

    def __enter__(self) -> "Companion":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        upload: tuple[str, bytes] | None = None,
    ) -> Any:
        connection = http.client.HTTPConnection(
            WORKSPACE.LOOPBACK, self.server.server_port, timeout=10
        )
        headers = {
            "Host": self.server.expected_host,
            "Authorization": f"Bearer {self.server.token}",
            "Origin": self.server.origin,
        }
        body: bytes | None = None
        if upload is not None:
            filename, content = upload
            envelope = {
                "metadata": payload or {},
                "filename": filename,
                "content": base64.b64encode(content).decode("ascii"),
            }
            body = json.dumps(envelope).encode("utf-8")
        elif payload is not None:
            body = json.dumps(payload).encode("utf-8")
        if body is not None:
            headers.update({
                "Content-Type": "application/json",
                "Content-Length": str(len(body)),
            })
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        if response.status != 200:
            raise OracleFailure("companion operation failed")
        try:
            return json.loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise OracleFailure("companion response invalid") from None
