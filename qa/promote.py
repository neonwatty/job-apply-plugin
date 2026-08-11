"""Fail-closed compilation, approval, and promotion for replay fixtures."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
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


@dataclass
class _SessionBinding:
    private: Path
    session: Path
    private_descriptor: int
    session_descriptor: int
    private_identity: os.stat_result
    session_identity: os.stat_result

    def close(self) -> None:
        os.close(self.session_descriptor)
        os.close(self.private_descriptor)


@dataclass
class _PrivateBinding(_SessionBinding):
    candidate: Path
    candidate_descriptor: int
    candidate_identity: os.stat_result

    def close(self) -> None:
        os.close(self.candidate_descriptor)
        super().close()


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _read_regular_at(
    directory_descriptor: int, name: str, diagnostic: str
) -> bytes:
    descriptor = None
    try:
        expected = os.stat(
            name, dir_fd=directory_descriptor, follow_symlinks=False
        )
        if not stat.S_ISREG(expected.st_mode) or expected.st_size > MAX_JSON_BYTES:
            raise PromotionError(diagnostic)
        descriptor = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_descriptor
        )
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
    except (OSError, RuntimeError, ValueError):
        raise PromotionError(diagnostic) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _read_json_at(directory_descriptor: int, name: str, diagnostic: str) -> Any:
    try:
        return json.loads(
            _read_regular_at(directory_descriptor, name, diagnostic).decode("utf-8")
        )
    except PromotionError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise PromotionError(diagnostic) from None


def _guard_existing_directory(path: Path, diagnostic: str) -> Path:
    absolute = Path(os.path.abspath(path))
    try:
        identity = absolute.lstat()
        resolved = absolute.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise PromotionError(diagnostic) from None
    if not stat.S_ISDIR(identity.st_mode) or stat.S_ISLNK(identity.st_mode):
        raise PromotionError(diagnostic)
    return resolved


def _open_session_binding(session_argument: Path) -> _SessionBinding:
    session = Path(os.path.abspath(session_argument))
    private = session.parent
    if private.name != ".qa-private" or session.name in {"", ".", ".."}:
        raise PromotionError("unsafe private session path")
    private_descriptor = session_descriptor = None
    binding = None
    try:
        private_identity = private.lstat()
        if not stat.S_ISDIR(private_identity.st_mode) or stat.S_ISLNK(
            private_identity.st_mode
        ):
            raise PromotionError("unsafe private session path")
        private_descriptor = os.open(
            private, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        )
        if not _same_identity(private_identity, os.fstat(private_descriptor)):
            raise PromotionError("private session changed")

        session_identity = os.stat(
            session.name, dir_fd=private_descriptor, follow_symlinks=False
        )
        session_descriptor = os.open(
            session.name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=private_descriptor,
        )
        if not _same_identity(session_identity, os.fstat(session_descriptor)):
            raise PromotionError("private session changed")
        binding = _SessionBinding(
            private,
            session,
            private_descriptor,
            session_descriptor,
            private_identity,
            session_identity,
        )
        return binding
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("private session changed") from None
    finally:
        if binding is None:
            if session_descriptor is not None:
                os.close(session_descriptor)
            if private_descriptor is not None:
                os.close(private_descriptor)


def _open_private_binding(candidate_argument: Path) -> _PrivateBinding:
    candidate = Path(os.path.abspath(candidate_argument))
    if candidate.name != "candidate":
        raise PromotionError("unsafe candidate path")
    session_binding = _open_session_binding(candidate.parent)
    candidate_descriptor = None
    binding = None
    try:
        candidate_identity = os.stat(
            candidate.name,
            dir_fd=session_binding.session_descriptor,
            follow_symlinks=False,
        )
        candidate_descriptor = os.open(
            candidate.name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=session_binding.session_descriptor,
        )
        if not _same_identity(candidate_identity, os.fstat(candidate_descriptor)):
            raise PromotionError("private session changed")
        binding = _PrivateBinding(
            session_binding.private,
            session_binding.session,
            session_binding.private_descriptor,
            session_binding.session_descriptor,
            session_binding.private_identity,
            session_binding.session_identity,
            candidate,
            candidate_descriptor,
            candidate_identity,
        )
        return binding
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("private session changed") from None
    finally:
        if binding is None:
            if candidate_descriptor is not None:
                os.close(candidate_descriptor)
            session_binding.close()


def _assert_session_binding(binding: _SessionBinding) -> None:
    try:
        if not _same_identity(binding.private_identity, binding.private.lstat()):
            raise PromotionError("private session changed")
        if not _same_identity(
            binding.private_identity, os.fstat(binding.private_descriptor)
        ):
            raise PromotionError("private session changed")
        named_session = os.stat(
            binding.session.name,
            dir_fd=binding.private_descriptor,
            follow_symlinks=False,
        )
        if not _same_identity(binding.session_identity, named_session) or not _same_identity(
            binding.session_identity, os.fstat(binding.session_descriptor)
        ):
            raise PromotionError("private session changed")
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("private session changed") from None


def _assert_private_binding(binding: _PrivateBinding) -> None:
    _assert_session_binding(binding)
    try:
        named_candidate = os.stat(
            binding.candidate.name,
            dir_fd=binding.session_descriptor,
            follow_symlinks=False,
        )
        if not _same_identity(
            binding.candidate_identity, named_candidate
        ) or not _same_identity(
            binding.candidate_identity, os.fstat(binding.candidate_descriptor)
        ):
            raise PromotionError("private session changed")
    except OSError:
        raise PromotionError("private session changed") from None


def _atomic_write_at(
    directory_descriptor: int, name: str, content: bytes
) -> None:
    temporary = f".{name}.{secrets.token_hex(8)}.tmp"
    descriptor = None
    try:
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=directory_descriptor,
        )
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(
            temporary,
            name,
            src_dir_fd=directory_descriptor,
            dst_dir_fd=directory_descriptor,
        )
        os.fsync(directory_descriptor)
    except OSError:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory_descriptor)
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

    session_binding = _open_session_binding(Path(capture))
    lexical_candidate = Path(os.path.abspath(candidate))
    candidate_descriptor = None
    binding = None
    created = False
    try:
        if lexical_candidate != session_binding.session / "candidate":
            raise PromotionError("unsafe candidate path")
        try:
            os.stat(
                "candidate",
                dir_fd=session_binding.session_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            pass
        except OSError:
            raise PromotionError("unsafe candidate path") from None
        else:
            raise PromotionError("unsafe candidate path")

        semantic = _read_json_at(
            session_binding.session_descriptor,
            "semantic.json",
            "invalid private inputs",
        )
        receipt = _read_json_at(
            session_binding.session_descriptor,
            "capture-receipt.json",
            "invalid private inputs",
        )
        try:
            fixture = compile_capture(semantic, receipt, fixture_id)
        except (ContractError, TypeError, ValueError):
            raise PromotionError("candidate compilation failed") from None

        try:
            os.mkdir(
                "candidate", mode=0o700, dir_fd=session_binding.session_descriptor
            )
            created = True
            candidate_identity = os.stat(
                "candidate",
                dir_fd=session_binding.session_descriptor,
                follow_symlinks=False,
            )
            candidate_descriptor = os.open(
                "candidate",
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=session_binding.session_descriptor,
            )
        except OSError:
            raise PromotionError("candidate creation failed") from None
        if not _same_identity(candidate_identity, os.fstat(candidate_descriptor)):
            raise PromotionError("private session changed")
        binding = _PrivateBinding(
            session_binding.private,
            session_binding.session,
            session_binding.private_descriptor,
            session_binding.session_descriptor,
            session_binding.private_identity,
            session_binding.session_identity,
            lexical_candidate,
            candidate_descriptor,
            candidate_identity,
        )
        _atomic_write_at(binding.candidate_descriptor, "fixture.json", _json_bytes(fixture))
        manifest = {
            "schemaVersion": PROMOTION_SCHEMA_VERSION,
            "fixtureId": fixture["id"],
            "paths": list(MANIFEST_PATHS),
            "stringCategories": list(MANIFEST_STRING_CATEGORIES),
        }
        _atomic_write_at(
            binding.candidate_descriptor,
            "review-manifest.json",
            _json_bytes(manifest),
        )
        scan_tree(binding.candidate, _denied_terms(semantic))
        _assert_private_binding(binding)
        return fixture
    except (OSError, PrivacyError, PromotionError) as error:
        if created and binding is not None:
            try:
                _assert_private_binding(binding)
                _remove_child_tree(
                    session_binding.session_descriptor, "candidate"
                )
            except (OSError, PromotionError):
                pass
        if isinstance(error, PrivacyError):
            raise PromotionError(str(error)) from None
        if isinstance(error, OSError):
            raise PromotionError("candidate creation failed") from None
        raise
    finally:
        if binding is not None:
            binding.close()
        else:
            if candidate_descriptor is not None:
                os.close(candidate_descriptor)
            session_binding.close()


def approve_candidate(candidate: Path, reviewer: str, now: str | None = None) -> dict[str, Any]:
    """Bind a human approval to the exact candidate fixture bytes and versions."""

    binding = _open_private_binding(Path(candidate))
    try:
        if not isinstance(reviewer, str) or not REVIEWER.fullmatch(reviewer):
            raise PromotionError("invalid reviewer")
        fixture_bytes = _read_regular_at(
            binding.candidate_descriptor,
            "fixture.json",
            "invalid fixture artifact",
        )
        fixture = _read_json_at(
            binding.candidate_descriptor,
            "fixture.json",
            "invalid fixture artifact",
        )
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
        _assert_private_binding(binding)
        _atomic_write_at(
            binding.candidate_descriptor, "approval.json", _json_bytes(approval)
        )
        _assert_private_binding(binding)
        return approval
    finally:
        binding.close()


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


def _destroy_bound_session(binding: _PrivateBinding) -> None:
    try:
        _assert_private_binding(binding)
        _remove_tree_contents(binding.session_descriptor)
        named_session = os.stat(
            binding.session.name,
            dir_fd=binding.private_descriptor,
            follow_symlinks=False,
        )
        if not _same_identity(binding.session_identity, named_session):
            raise PromotionError("private session deletion failed")
        os.rmdir(binding.session.name, dir_fd=binding.private_descriptor)
    except PromotionError:
        raise
    except (OSError, ValueError):
        raise PromotionError("private session deletion failed") from None


def promote_candidate(candidate: Path, destination: Path, now: str | None = None) -> Path:
    """Revalidate, atomically install, then securely destroy the raw session."""

    binding = _open_private_binding(Path(candidate))
    try:
        return _promote_bound_candidate(binding, Path(destination), now)
    finally:
        binding.close()


def _promote_bound_candidate(
    binding: _PrivateBinding, destination_argument: Path, now: str | None
) -> Path:
    _assert_private_binding(binding)
    try:
        os.stat(
            "approval.json",
            dir_fd=binding.candidate_descriptor,
            follow_symlinks=False,
        )
    except OSError:
        raise PromotionError("approval required") from None

    fixture_bytes = _read_regular_at(
        binding.candidate_descriptor, "fixture.json", "invalid fixture artifact"
    )
    digest = hashlib.sha256(fixture_bytes).hexdigest()
    approval = _validate_approval(
        _read_json_at(binding.candidate_descriptor, "approval.json", "invalid approval"),
        digest,
    )
    fixture = _read_json_at(
        binding.candidate_descriptor, "fixture.json", "invalid fixture artifact"
    )
    try:
        validate_fixture(fixture)
    except ContractError:
        raise PromotionError("invalid fixture artifact") from None

    semantic = _read_json_at(
        binding.session_descriptor, "semantic.json", "invalid private inputs"
    )
    receipt = _read_json_at(
        binding.session_descriptor, "capture-receipt.json", "invalid private inputs"
    )
    try:
        rebuilt = compile_capture(semantic, receipt, fixture["id"])
    except (ContractError, TypeError, ValueError):
        raise PromotionError("invalid private inputs") from None
    if rebuilt != fixture:
        raise PromotionError("fixture does not match private inputs")

    try:
        scan_tree(binding.candidate, _denied_terms(semantic))
    except PrivacyError as error:
        raise PromotionError(str(error)) from None
    _assert_private_binding(binding)
    _validate_manifest(
        _read_json_at(
            binding.candidate_descriptor,
            "review-manifest.json",
            "invalid review manifest",
        ),
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

    display_destination = Path(os.path.abspath(destination_argument))
    destination = _safe_destination(destination_argument)
    _assert_private_binding(binding)
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
        _assert_private_binding(binding)
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

    _destroy_bound_session(binding)
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
