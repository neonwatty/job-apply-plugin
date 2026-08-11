"""Fail-closed compilation, approval, and promotion for replay fixtures."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
from typing import Any

from qa.compiler import COMPILER_VERSION, compile_capture
from qa.contracts import ContractError, validate_fixture
from qa.privacy import (
    MAX_DENIED_TERM_CHARS,
    MAX_DENIED_TERMS,
    PrivacyError,
    scan_tree,
)


SCANNER_VERSION = "1.0.0"
PROMOTION_SCHEMA_VERSION = 1
MAX_JSON_BYTES = 1024 * 1024
REVIEWER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

APPROVAL_KEYS = {
    "schemaVersion",
    "reviewer",
    "fixtureSha256",
    "compilerVersion",
    "scannerVersion",
    "approvedAt",
}
MANIFEST_KEYS = {"schemaVersion", "fixtureId", "paths", "stringCategories"}
PROVENANCE_KEYS = {
    "schemaVersion",
    "fixtureId",
    "platformFamily",
    "captureMonth",
    "recorderVersion",
    "compilerVersion",
    "scannerVersion",
    "sourceRecordingSha256",
    "fixtureSha256",
    "approvedBy",
    "approvedAt",
    "promotedAt",
}
MANIFEST_PATHS = ["approval.json", "fixture.json", "provenance.json"]
MANIFEST_STRING_CATEGORIES = [
    "fixture-identifiers",
    "generic-control-labels",
    "generic-step-titles",
    "platform-family",
    "provenance-versions",
    "reviewer-identifier",
    "timestamps",
]


class PromotionError(ValueError):
    """A stable, value-free promotion diagnostic."""


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _read_regular(path: Path, diagnostic: str) -> bytes:
    descriptor = None
    try:
        expected = path.lstat()
        if not stat.S_ISREG(expected.st_mode) or expected.st_size > MAX_JSON_BYTES:
            raise PromotionError(diagnostic)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or not _same_identity(expected, opened):
            raise PromotionError(diagnostic)
        chunks: list[bytes] = []
        remaining = MAX_JSON_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > MAX_JSON_BYTES:
            raise PromotionError(diagnostic)
        return data
    except PromotionError:
        raise
    except OSError:
        raise PromotionError(diagnostic) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_json(path: Path, diagnostic: str) -> Any:
    try:
        return json.loads(_read_regular(path, diagnostic).decode("utf-8"))
    except PromotionError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise PromotionError(diagnostic) from None


def _guard_existing_directory(path: Path, diagnostic: str) -> Path:
    absolute = Path(os.path.abspath(path))
    try:
        identity = absolute.lstat()
        resolved = absolute.resolve(strict=True)
    except OSError:
        raise PromotionError(diagnostic) from None
    if not stat.S_ISDIR(identity.st_mode) or stat.S_ISLNK(identity.st_mode):
        raise PromotionError(diagnostic)
    return resolved


def _guard_session(session: Path) -> tuple[Path, Path]:
    lexical_session = Path(os.path.abspath(session))
    lexical_private = lexical_session.parent
    if (
        lexical_private.name != ".qa-private"
        or lexical_session.name in {"", ".", ".."}
    ):
        raise PromotionError("unsafe private session path")
    private = _guard_existing_directory(
        lexical_private, "unsafe private session path"
    )
    session = _guard_existing_directory(
        lexical_session, "unsafe private session path"
    )
    if session.parent != private:
        raise PromotionError("unsafe private session path")
    return private, session


def _guard_candidate(candidate: Path) -> tuple[Path, Path, Path]:
    lexical_candidate = Path(os.path.abspath(candidate))
    if lexical_candidate.name != "candidate":
        raise PromotionError("unsafe candidate path")
    private, session = _guard_session(lexical_candidate.parent)
    candidate = _guard_existing_directory(
        lexical_candidate, "unsafe candidate path"
    )
    if candidate.parent != session:
        raise PromotionError("unsafe candidate path")
    return private, session, candidate


def _atomic_write(path: Path, content: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, path)
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except OSError:
            pass
        raise PromotionError("candidate write failed") from None


def _denied_terms(semantic: Any) -> list[str]:
    if not isinstance(semantic, dict):
        raise PromotionError("invalid private inputs")
    terms = semantic.get("sourceDeniedTerms")
    if (
        not isinstance(terms, list)
        or len(terms) > MAX_DENIED_TERMS
        or any(
            not isinstance(term, str) or len(term) > MAX_DENIED_TERM_CHARS
            for term in terms
        )
    ):
        raise PromotionError("invalid private inputs")
    return terms


def _timestamp(value: str | None) -> str:
    if value is None:
        value = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
            "+00:00", "Z"
        )
    if not isinstance(value, str) or len(value) > 64:
        raise PromotionError("invalid timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise PromotionError("invalid timestamp") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PromotionError("invalid timestamp")
    return value


def compile_candidate(capture: Path, fixture_id: str, candidate: Path) -> dict[str, Any]:
    """Compile the two permitted private inputs into a review candidate."""

    _, capture = _guard_session(Path(capture))
    lexical_candidate = Path(os.path.abspath(candidate))
    if (
        lexical_candidate.name != "candidate"
        or lexical_candidate.parent.resolve(strict=True) != capture
        or lexical_candidate.exists()
    ):
        raise PromotionError("unsafe candidate path")
    candidate = capture / "candidate"
    semantic = _read_json(capture / "semantic.json", "invalid private inputs")
    receipt = _read_json(capture / "capture-receipt.json", "invalid private inputs")
    try:
        fixture = compile_capture(semantic, receipt, fixture_id)
    except (ContractError, TypeError, ValueError):
        raise PromotionError("candidate compilation failed") from None

    try:
        candidate.mkdir(mode=0o700)
        _atomic_write(candidate / "fixture.json", _json_bytes(fixture))
        manifest = {
            "schemaVersion": PROMOTION_SCHEMA_VERSION,
            "fixtureId": fixture["id"],
            "paths": list(MANIFEST_PATHS),
            "stringCategories": list(MANIFEST_STRING_CATEGORIES),
        }
        _atomic_write(candidate / "review-manifest.json", _json_bytes(manifest))
        scan_tree(candidate, _denied_terms(semantic))
        return fixture
    except (OSError, PrivacyError, PromotionError) as error:
        shutil.rmtree(candidate, ignore_errors=True)
        if isinstance(error, PrivacyError):
            raise PromotionError(str(error)) from None
        raise


def approve_candidate(candidate: Path, reviewer: str, now: str | None = None) -> dict[str, Any]:
    """Bind a human approval to the exact candidate fixture bytes and versions."""

    _, _, candidate = _guard_candidate(Path(candidate))
    if not isinstance(reviewer, str) or not REVIEWER.fullmatch(reviewer):
        raise PromotionError("invalid reviewer")
    fixture_bytes = _read_regular(candidate / "fixture.json", "invalid fixture artifact")
    fixture = _read_json(candidate / "fixture.json", "invalid fixture artifact")
    try:
        validate_fixture(fixture)
    except ContractError:
        raise PromotionError("invalid fixture artifact") from None
    approval = {
        "schemaVersion": PROMOTION_SCHEMA_VERSION,
        "reviewer": reviewer,
        "fixtureSha256": hashlib.sha256(fixture_bytes).hexdigest(),
        "compilerVersion": COMPILER_VERSION,
        "scannerVersion": SCANNER_VERSION,
        "approvedAt": _timestamp(now),
    }
    _atomic_write(candidate / "approval.json", _json_bytes(approval))
    return approval


def _validate_approval(value: Any, digest: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != APPROVAL_KEYS:
        raise PromotionError("invalid approval")
    if (
        value.get("schemaVersion") != PROMOTION_SCHEMA_VERSION
        or isinstance(value.get("schemaVersion"), bool)
        or not isinstance(value.get("reviewer"), str)
        or not REVIEWER.fullmatch(value["reviewer"])
        or value.get("fixtureSha256") != digest
        or value.get("compilerVersion") != COMPILER_VERSION
        or value.get("scannerVersion") != SCANNER_VERSION
    ):
        if value.get("fixtureSha256") != digest:
            raise PromotionError("fixture hash mismatch")
        raise PromotionError("invalid approval")
    _timestamp(value.get("approvedAt"))
    return value


def _validate_manifest(value: Any, fixture_id: str) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != MANIFEST_KEYS
        or value.get("schemaVersion") != PROMOTION_SCHEMA_VERSION
        or isinstance(value.get("schemaVersion"), bool)
        or value.get("fixtureId") != fixture_id
        or value.get("paths") != MANIFEST_PATHS
        or value.get("stringCategories") != MANIFEST_STRING_CATEGORIES
    ):
        raise PromotionError("invalid review manifest")


def _safe_destination(destination: Path) -> Path:
    destination = Path(os.path.abspath(destination))
    missing: list[Path] = []
    current = destination
    while not current.exists():
        missing.append(current)
        if current.parent == current:
            raise PromotionError("unsafe destination path")
        current = current.parent
    current = _guard_existing_directory(current, "unsafe destination path")
    for path in reversed(missing):
        path = current / path.name
        try:
            path.mkdir(mode=0o755)
        except OSError:
            raise PromotionError("unsafe destination path") from None
        current = _guard_existing_directory(path, "unsafe destination path")
    return _guard_existing_directory(destination, "unsafe destination path")


def _write_staging_file(directory_descriptor: int, name: str, content: bytes) -> None:
    descriptor = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o644,
        dir_fd=directory_descriptor,
    )
    try:
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _remove_tree_contents(directory_descriptor: int) -> None:
    entries = list(os.scandir(directory_descriptor))
    for entry in entries:
        identity = entry.stat(follow_symlinks=False)
        if stat.S_ISDIR(identity.st_mode) and not stat.S_ISLNK(identity.st_mode):
            child = os.open(
                entry.name,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=directory_descriptor,
            )
            try:
                if not _same_identity(identity, os.fstat(child)):
                    raise PromotionError("private session deletion failed")
                _remove_tree_contents(child)
            finally:
                os.close(child)
            os.rmdir(entry.name, dir_fd=directory_descriptor)
        else:
            os.unlink(entry.name, dir_fd=directory_descriptor)


def _remove_child_tree(parent_descriptor: int, name: str) -> None:
    child = os.open(
        name,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        dir_fd=parent_descriptor,
    )
    try:
        _remove_tree_contents(child)
    finally:
        os.close(child)
    os.rmdir(name, dir_fd=parent_descriptor)


def _destroy_session(private: Path, session: Path) -> None:
    private_descriptor = session_descriptor = None
    try:
        private_descriptor = os.open(private, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        expected = os.stat(session.name, dir_fd=private_descriptor, follow_symlinks=False)
        session_descriptor = os.open(
            session.name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=private_descriptor,
        )
        if not _same_identity(expected, os.fstat(session_descriptor)):
            raise PromotionError("private session deletion failed")
        _remove_tree_contents(session_descriptor)
        os.close(session_descriptor)
        session_descriptor = None
        os.rmdir(session.name, dir_fd=private_descriptor)
    except (OSError, ValueError):
        raise PromotionError("private session deletion failed") from None
    finally:
        if session_descriptor is not None:
            os.close(session_descriptor)
        if private_descriptor is not None:
            os.close(private_descriptor)


def promote_candidate(candidate: Path, destination: Path, now: str | None = None) -> Path:
    """Revalidate, atomically install, then securely destroy the raw session."""

    private, session, candidate = _guard_candidate(Path(candidate))
    approval_path = candidate / "approval.json"
    if not approval_path.exists():
        raise PromotionError("approval required")

    fixture_bytes = _read_regular(candidate / "fixture.json", "invalid fixture artifact")
    digest = hashlib.sha256(fixture_bytes).hexdigest()
    approval = _validate_approval(_read_json(approval_path, "invalid approval"), digest)
    fixture = _read_json(candidate / "fixture.json", "invalid fixture artifact")
    try:
        validate_fixture(fixture)
    except ContractError:
        raise PromotionError("invalid fixture artifact") from None

    semantic = _read_json(session / "semantic.json", "invalid private inputs")
    receipt = _read_json(session / "capture-receipt.json", "invalid private inputs")
    try:
        rebuilt = compile_capture(semantic, receipt, fixture["id"])
    except (ContractError, TypeError, ValueError):
        raise PromotionError("invalid private inputs") from None
    if rebuilt != fixture:
        raise PromotionError("fixture does not match private inputs")

    try:
        scan_tree(candidate, _denied_terms(semantic))
    except PrivacyError as error:
        raise PromotionError(str(error)) from None
    _validate_manifest(
        _read_json(candidate / "review-manifest.json", "invalid review manifest"),
        fixture["id"],
    )

    promoted_at = _timestamp(now)
    provenance = {
        "schemaVersion": PROMOTION_SCHEMA_VERSION,
        "fixtureId": fixture["id"],
        "platformFamily": fixture["platformFamily"],
        "captureMonth": fixture["captureMonth"],
        "recorderVersion": fixture["provenance"]["recorderVersion"],
        "compilerVersion": COMPILER_VERSION,
        "scannerVersion": SCANNER_VERSION,
        "sourceRecordingSha256": fixture["provenance"]["sourceRecordingSha256"],
        "fixtureSha256": digest,
        "approvedBy": approval["reviewer"],
        "approvedAt": approval["approvedAt"],
        "promotedAt": promoted_at,
    }
    if set(provenance) != PROVENANCE_KEYS:
        raise PromotionError("invalid provenance")

    display_destination = Path(os.path.abspath(destination))
    destination = _safe_destination(Path(destination))
    destination_descriptor = staging_descriptor = None
    staging_name = f".{fixture['id']}.{secrets.token_hex(8)}"
    try:
        expected_destination = destination.lstat()
        destination_descriptor = os.open(
            destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        )
        if not _same_identity(expected_destination, os.fstat(destination_descriptor)):
            raise PromotionError("unsafe destination path")
        os.mkdir(staging_name, mode=0o755, dir_fd=destination_descriptor)
        staging_descriptor = os.open(
            staging_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=destination_descriptor,
        )
        _write_staging_file(staging_descriptor, "fixture.json", fixture_bytes)
        _write_staging_file(
            staging_descriptor, "approval.json", _json_bytes(approval)
        )
        _write_staging_file(
            staging_descriptor, "provenance.json", _json_bytes(provenance)
        )
        os.fsync(staging_descriptor)
        os.close(staging_descriptor)
        staging_descriptor = None
        try:
            os.replace(
                staging_name,
                fixture["id"],
                src_dir_fd=destination_descriptor,
                dst_dir_fd=destination_descriptor,
            )
            os.fsync(destination_descriptor)
        except OSError:
            raise PromotionError("atomic install failed") from None
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("atomic install failed") from None
    finally:
        if staging_descriptor is not None:
            os.close(staging_descriptor)
        if destination_descriptor is not None:
            try:
                os.stat(
                    staging_name,
                    dir_fd=destination_descriptor,
                    follow_symlinks=False,
                )
            except OSError:
                pass
            else:
                try:
                    _remove_child_tree(destination_descriptor, staging_name)
                except OSError:
                    pass
            os.close(destination_descriptor)

    _destroy_session(private, session)
    return display_destination / fixture["id"]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    compile_parser = subcommands.add_parser("compile")
    compile_parser.add_argument("--capture", type=Path, required=True)
    compile_parser.add_argument("--fixture-id", required=True)
    compile_parser.add_argument("--candidate", type=Path, required=True)
    approve_parser = subcommands.add_parser("approve")
    approve_parser.add_argument("--candidate", type=Path, required=True)
    approve_parser.add_argument("--reviewer", required=True)
    promote_parser = subcommands.add_parser("promote")
    promote_parser.add_argument("--candidate", type=Path, required=True)
    promote_parser.add_argument("--destination", type=Path, required=True)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "compile":
            compile_candidate(arguments.capture, arguments.fixture_id, arguments.candidate)
        elif arguments.command == "approve":
            approve_candidate(arguments.candidate, arguments.reviewer)
        else:
            promote_candidate(arguments.candidate, arguments.destination)
    except PromotionError as error:
        print(str(error), file=__import__("sys").stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
