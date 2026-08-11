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
import sys
import tempfile
from typing import Any

from qa.compiler import COMPILER_VERSION, compile_capture
from qa.contracts import ContractError, validate_fixture
from qa.privacy import (
    MAX_DENIED_TERM_CHARS,
    MAX_DENIED_TERMS,
    PrivacyError,
    scan_tree,
)
from qa.recorder_fs import BrokerError, _EXCLUSIVE_RENAME, exclusive_rename


SCANNER_VERSION = "1.0.0"
PROMOTION_SCHEMA_VERSION = 1
MAX_JSON_BYTES = 1024 * 1024
MAX_DELETE_DEPTH = 32
MAX_DELETE_ENTRIES = 4096
MAX_DELETE_ENTRIES_PER_DIRECTORY = 1024
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

_POSIX_DESCRIPTOR_SUPPORT = (
    os.name == "posix"
    and hasattr(os, "O_DIRECTORY")
    and hasattr(os, "O_NOFOLLOW")
    and hasattr(os, "O_CLOEXEC")
    and os.open in getattr(os, "supports_dir_fd", set())
    and os.stat in getattr(os, "supports_dir_fd", set())
    and os.mkdir in getattr(os, "supports_dir_fd", set())
    and os.unlink in getattr(os, "supports_dir_fd", set())
    and os.rmdir in getattr(os, "supports_dir_fd", set())
    and os.scandir in getattr(os, "supports_fd", set())
)


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
    mount_identity: tuple[int, int]

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


@dataclass
class _DestinationBinding:
    root: Path
    destination: Path
    root_descriptor: int
    qa_descriptor: int
    destination_descriptor: int
    root_identity: os.stat_result
    qa_identity: os.stat_result
    destination_identity: os.stat_result

    def close(self) -> None:
        os.close(self.destination_descriptor)
        os.close(self.qa_descriptor)
        os.close(self.root_descriptor)


@dataclass
class _DeleteNode:
    name: str
    identity: os.stat_result
    children: list["_DeleteNode"] | None


def _deletion_entry_identity(entry: os.DirEntry[str]) -> os.stat_result:
    return entry.stat(follow_symlinks=False)


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _require_posix_capabilities(*, exclusive_install: bool = False) -> None:
    if not _POSIX_DESCRIPTOR_SUPPORT or (
        exclusive_install and _EXCLUSIVE_RENAME is None
    ) or not (sys.platform == "darwin" or sys.platform.startswith("linux")):
        raise PromotionError("unsupported platform")


def _descriptor_mount_identity(descriptor: int) -> tuple[int, int]:
    device = os.fstat(descriptor).st_dev
    if sys.platform.startswith("linux"):
        fdinfo = None
        try:
            fdinfo = os.open(
                f"/proc/self/fdinfo/{descriptor}", os.O_RDONLY | os.O_CLOEXEC
            )
            data = os.read(fdinfo, 16 * 1024)
            if os.read(fdinfo, 1):
                raise PromotionError("unsafe mount boundary")
            for line in data.splitlines():
                if line.startswith(b"mnt_id:"):
                    value = line.split(b":", 1)[1].strip()
                    if value.isdigit():
                        return device, int(value)
            raise PromotionError("unsafe mount boundary")
        except PromotionError:
            raise
        except OSError:
            raise PromotionError("unsafe mount boundary") from None
        finally:
            if fdinfo is not None:
                os.close(fdinfo)
    if sys.platform == "darwin":
        return device, device
    raise PromotionError("unsupported platform")


def _require_private_permissions(identity: os.stat_result) -> None:
    if identity.st_uid != os.getuid() or stat.S_IMODE(identity.st_mode) != 0o700:
        raise PromotionError("unsafe private permissions")


def _darwin_mountpoint_bound(
    path: Path, identity: os.stat_result, descriptor: int
) -> bool:
    if sys.platform != "darwin":
        return False
    try:
        before = path.lstat()
        mounted = os.path.ismount(path)
        after = path.lstat()
        opened = os.fstat(descriptor)
    except (OSError, RuntimeError, ValueError):
        raise PromotionError("unsafe mount boundary") from None
    if not (
        _same_identity(identity, before)
        and _same_identity(identity, after)
        and _same_identity(identity, opened)
    ):
        raise PromotionError("unsafe mount boundary")
    return mounted


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


def _parse_json_bytes(data: bytes, diagnostic: str) -> Any:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise PromotionError(diagnostic) from None


def _candidate_snapshot(binding: _PrivateBinding) -> dict[str, bytes]:
    expected = {"fixture.json", "review-manifest.json", "approval.json"}
    names: set[str] = set()
    try:
        with os.scandir(binding.candidate_descriptor) as entries:
            for entry in entries:
                if entry.name not in expected or entry.name in names:
                    raise PromotionError("invalid candidate inventory")
                names.add(entry.name)
    except PromotionError:
        raise
    except (OSError, MemoryError):
        raise PromotionError("invalid candidate inventory") from None
    if names != expected:
        raise PromotionError("invalid candidate inventory")
    return {
        name: _read_regular_at(
            binding.candidate_descriptor, name, "invalid candidate artifact"
        )
        for name in sorted(expected)
    }


def _scan_snapshot(snapshot: dict[str, bytes], denied_terms: list[str]) -> None:
    try:
        with tempfile.TemporaryDirectory(prefix="qa-promotion-scan-") as temporary:
            root = Path(temporary)
            for name, data in snapshot.items():
                (root / name).write_bytes(data)
            scan_tree(root, denied_terms)
    except PrivacyError:
        raise PromotionError("privacy scan failed") from None
    except (OSError, MemoryError):
        raise PromotionError("privacy scan failed") from None


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
        _require_private_permissions(private_identity)
        mount_identity = _descriptor_mount_identity(private_descriptor)

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
        _require_private_permissions(session_identity)
        if (
            session_identity.st_dev != private_identity.st_dev
            or _descriptor_mount_identity(session_descriptor) != mount_identity
            or _darwin_mountpoint_bound(session, session_identity, session_descriptor)
        ):
            raise PromotionError("unsafe mount boundary")
        binding = _SessionBinding(
            private,
            session,
            private_descriptor,
            session_descriptor,
            private_identity,
            session_identity,
            mount_identity,
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
        _require_private_permissions(candidate_identity)
        if (
            candidate_identity.st_dev != session_binding.session_identity.st_dev
            or _descriptor_mount_identity(candidate_descriptor)
            != session_binding.mount_identity
            or _darwin_mountpoint_bound(
                candidate, candidate_identity, candidate_descriptor
            )
        ):
            raise PromotionError("unsafe mount boundary")
        binding = _PrivateBinding(
            session_binding.private,
            session_binding.session,
            session_binding.private_descriptor,
            session_binding.session_descriptor,
            session_binding.private_identity,
            session_binding.session_identity,
            session_binding.mount_identity,
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
        _require_private_permissions(os.fstat(binding.private_descriptor))
        if _descriptor_mount_identity(binding.private_descriptor) != binding.mount_identity:
            raise PromotionError("unsafe mount boundary")
        named_session = os.stat(
            binding.session.name,
            dir_fd=binding.private_descriptor,
            follow_symlinks=False,
        )
        if not _same_identity(binding.session_identity, named_session) or not _same_identity(
            binding.session_identity, os.fstat(binding.session_descriptor)
        ):
            raise PromotionError("private session changed")
        _require_private_permissions(os.fstat(binding.session_descriptor))
        if (
            _descriptor_mount_identity(binding.session_descriptor)
            != binding.mount_identity
            or _darwin_mountpoint_bound(
                binding.session, named_session, binding.session_descriptor
            )
        ):
            raise PromotionError("unsafe mount boundary")
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
        _require_private_permissions(os.fstat(binding.candidate_descriptor))
        if (
            _descriptor_mount_identity(binding.candidate_descriptor)
            != binding.mount_identity
            or _darwin_mountpoint_bound(
                binding.session / binding.candidate.name,
                named_candidate,
                binding.candidate_descriptor,
            )
        ):
            raise PromotionError("unsafe mount boundary")
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

    _require_posix_capabilities()
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
        _require_private_permissions(candidate_identity)
        if (
            candidate_identity.st_dev != session_binding.session_identity.st_dev
            or _descriptor_mount_identity(candidate_descriptor)
            != session_binding.mount_identity
            or _darwin_mountpoint_bound(
                lexical_candidate, candidate_identity, candidate_descriptor
            )
        ):
            raise PromotionError("unsafe mount boundary")
        binding = _PrivateBinding(
            session_binding.private,
            session_binding.session,
            session_binding.private_descriptor,
            session_binding.session_descriptor,
            session_binding.private_identity,
            session_binding.session_identity,
            session_binding.mount_identity,
            lexical_candidate,
            candidate_descriptor,
            candidate_identity,
        )
        fixture_output = _json_bytes(fixture)
        _atomic_write_at(binding.candidate_descriptor, "fixture.json", fixture_output)
        manifest = {
            "schemaVersion": PROMOTION_SCHEMA_VERSION,
            "fixtureId": fixture["id"],
            "paths": list(MANIFEST_PATHS),
            "stringCategories": list(MANIFEST_STRING_CATEGORIES),
        }
        manifest_output = _json_bytes(manifest)
        _atomic_write_at(
            binding.candidate_descriptor,
            "review-manifest.json",
            manifest_output,
        )
        _scan_snapshot(
            {
                "fixture.json": fixture_output,
                "review-manifest.json": manifest_output,
            },
            _denied_terms(semantic),
        )
        _assert_private_binding(binding)
        return fixture
    except (OSError, PromotionError) as error:
        if created and binding is not None:
            try:
                _assert_private_binding(binding)
                _remove_child_tree(
                    session_binding.session_descriptor, "candidate"
                )
            except (OSError, PromotionError):
                pass
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

    _require_posix_capabilities()
    binding = _open_private_binding(Path(candidate))
    try:
        if not isinstance(reviewer, str) or not REVIEWER.fullmatch(reviewer):
            raise PromotionError("invalid reviewer")
        fixture_bytes = _read_regular_at(
            binding.candidate_descriptor,
            "fixture.json",
            "invalid fixture artifact",
        )
        fixture = _parse_json_bytes(
            fixture_bytes, "invalid fixture artifact"
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


def _open_destination_binding(destination_argument: Path) -> _DestinationBinding:
    destination = Path(os.path.abspath(destination_argument))
    if destination.name != "fixtures" or destination.parent.name != "qa":
        raise PromotionError("unsafe destination path")
    root = destination.parent.parent
    root_descriptor = qa_descriptor = destination_descriptor = None
    binding = None
    try:
        root_identity = root.lstat()
        if not stat.S_ISDIR(root_identity.st_mode) or stat.S_ISLNK(
            root_identity.st_mode
        ):
            raise PromotionError("unsafe destination path")
        root_descriptor = os.open(
            root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        )
        if not _same_identity(root_identity, os.fstat(root_descriptor)):
            raise PromotionError("unsafe destination path")
        qa_identity = os.stat("qa", dir_fd=root_descriptor, follow_symlinks=False)
        qa_descriptor = os.open(
            "qa",
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=root_descriptor,
        )
        if not _same_identity(qa_identity, os.fstat(qa_descriptor)):
            raise PromotionError("unsafe destination path")
        destination_identity = os.stat(
            "fixtures", dir_fd=qa_descriptor, follow_symlinks=False
        )
        destination_descriptor = os.open(
            "fixtures",
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=qa_descriptor,
        )
        if not _same_identity(
            destination_identity, os.fstat(destination_descriptor)
        ):
            raise PromotionError("unsafe destination path")
        binding = _DestinationBinding(
            root,
            destination,
            root_descriptor,
            qa_descriptor,
            destination_descriptor,
            root_identity,
            qa_identity,
            destination_identity,
        )
        return binding
    except PromotionError:
        raise
    except (OSError, ValueError, RuntimeError):
        raise PromotionError("unsafe destination path") from None
    finally:
        if binding is None:
            if destination_descriptor is not None:
                os.close(destination_descriptor)
            if qa_descriptor is not None:
                os.close(qa_descriptor)
            if root_descriptor is not None:
                os.close(root_descriptor)


def _assert_destination_binding(binding: _DestinationBinding) -> None:
    try:
        if not _same_identity(binding.root_identity, binding.root.lstat()):
            raise PromotionError("unsafe destination path")
        named_qa = os.stat("qa", dir_fd=binding.root_descriptor, follow_symlinks=False)
        named_destination = os.stat(
            "fixtures", dir_fd=binding.qa_descriptor, follow_symlinks=False
        )
        if (
            not _same_identity(binding.root_identity, os.fstat(binding.root_descriptor))
            or not _same_identity(binding.qa_identity, named_qa)
            or not _same_identity(binding.qa_identity, os.fstat(binding.qa_descriptor))
            or not _same_identity(binding.destination_identity, named_destination)
            or not _same_identity(
                binding.destination_identity, os.fstat(binding.destination_descriptor)
            )
        ):
            raise PromotionError("unsafe destination path")
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("unsafe destination path") from None


def _reject_overlap(private: _PrivateBinding, destination: _DestinationBinding) -> None:
    _assert_private_binding(private)
    _assert_destination_binding(destination)
    try:
        destination_text = str(destination.destination.resolve(strict=True))
        for protected in (private.private, private.session, private.candidate):
            protected_text = str(protected.resolve(strict=True))
            if (
                os.path.commonpath((destination_text, protected_text))
                == protected_text
            ):
                raise PromotionError("unsafe destination path")
        protected_identities = {
            (private.private_identity.st_dev, private.private_identity.st_ino),
            (private.session_identity.st_dev, private.session_identity.st_ino),
            (private.candidate_identity.st_dev, private.candidate_identity.st_ino),
        }
        destination_identities = {
            (destination.root_identity.st_dev, destination.root_identity.st_ino),
            (destination.qa_identity.st_dev, destination.qa_identity.st_ino),
            (
                destination.destination_identity.st_dev,
                destination.destination_identity.st_ino,
            ),
        }
        if protected_identities & destination_identities:
            raise PromotionError("unsafe destination path")
    except (OSError, RuntimeError, ValueError):
        raise PromotionError("unsafe destination path") from None


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


def _remove_tree_contents(
    directory_descriptor: int,
    *,
    depth: int = 0,
    state: list[int] | None = None,
    device: int | None = None,
    mount_identity: tuple[int, int] | None = None,
) -> None:
    if state is None:
        state = [0]
    if depth > MAX_DELETE_DEPTH:
        raise PromotionError("bounded cleanup failed")
    if device is None:
        device = os.fstat(directory_descriptor).st_dev
    if mount_identity is None:
        mount_identity = _descriptor_mount_identity(directory_descriptor)
    per_directory = 0
    with os.scandir(directory_descriptor) as entries:
        for entry in entries:
            per_directory += 1
            state[0] += 1
            if (
                per_directory > MAX_DELETE_ENTRIES_PER_DIRECTORY
                or state[0] > MAX_DELETE_ENTRIES
            ):
                raise PromotionError("bounded cleanup failed")
            identity = entry.stat(follow_symlinks=False)
            if identity.st_dev != device:
                raise PromotionError("bounded cleanup failed")
            if stat.S_ISDIR(identity.st_mode) and not stat.S_ISLNK(identity.st_mode):
                child = os.open(
                    entry.name,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=directory_descriptor,
                )
                try:
                    if not _same_identity(identity, os.fstat(child)):
                        raise PromotionError("bounded cleanup failed")
                    if _descriptor_mount_identity(child) != mount_identity:
                        raise PromotionError("bounded cleanup failed")
                    _remove_tree_contents(
                        child,
                        depth=depth + 1,
                        state=state,
                        device=device,
                        mount_identity=mount_identity,
                    )
                finally:
                    os.close(child)
                os.rmdir(entry.name, dir_fd=directory_descriptor)
            elif stat.S_ISREG(identity.st_mode) or stat.S_ISLNK(identity.st_mode):
                os.unlink(entry.name, dir_fd=directory_descriptor)
            else:
                raise PromotionError("bounded cleanup failed")


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


def _preflight_deletion(binding: _PrivateBinding) -> list[_DeleteNode]:
    total = 0
    session_device = binding.session_identity.st_dev

    def walk(
        directory_descriptor: int, depth: int, directory_path: Path
    ) -> list[_DeleteNode]:
        nonlocal total
        if depth > MAX_DELETE_DEPTH:
            raise PromotionError("deletion preflight failed")
        nodes: list[_DeleteNode] = []
        per_directory = 0
        try:
            with os.scandir(directory_descriptor) as entries:
                for entry in entries:
                    per_directory += 1
                    total += 1
                    if (
                        per_directory > MAX_DELETE_ENTRIES_PER_DIRECTORY
                        or total > MAX_DELETE_ENTRIES
                    ):
                        raise PromotionError("deletion preflight failed")
                    identity = _deletion_entry_identity(entry)
                    if identity.st_dev != session_device:
                        raise PromotionError("deletion preflight failed")
                    if stat.S_ISDIR(identity.st_mode):
                        child = os.open(
                            entry.name,
                            os.O_RDONLY
                            | os.O_DIRECTORY
                            | os.O_NOFOLLOW
                            | os.O_CLOEXEC,
                            dir_fd=directory_descriptor,
                        )
                        try:
                            opened = os.fstat(child)
                            if (
                                not _same_identity(identity, opened)
                                or opened.st_dev != session_device
                                or _descriptor_mount_identity(child)
                                != binding.mount_identity
                                or _darwin_mountpoint_bound(
                                    directory_path / entry.name,
                                    identity,
                                    child,
                                )
                            ):
                                raise PromotionError("deletion preflight failed")
                            children = walk(
                                child, depth + 1, directory_path / entry.name
                            )
                        finally:
                            os.close(child)
                        nodes.append(_DeleteNode(entry.name, identity, children))
                    elif stat.S_ISREG(identity.st_mode):
                        child = os.open(
                            entry.name,
                            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=directory_descriptor,
                        )
                        try:
                            if (
                                not _same_identity(identity, os.fstat(child))
                                or _descriptor_mount_identity(child)
                                != binding.mount_identity
                                or _darwin_mountpoint_bound(
                                    directory_path / entry.name,
                                    identity,
                                    child,
                                )
                            ):
                                raise PromotionError("deletion preflight failed")
                        finally:
                            os.close(child)
                        nodes.append(_DeleteNode(entry.name, identity, None))
                    elif stat.S_ISLNK(identity.st_mode):
                        nodes.append(_DeleteNode(entry.name, identity, None))
                    else:
                        raise PromotionError("deletion preflight failed")
        except PromotionError:
            raise
        except (OSError, MemoryError, RecursionError):
            raise PromotionError("deletion preflight failed") from None
        return nodes

    _assert_private_binding(binding)
    return walk(binding.session_descriptor, 0, binding.session)


def _delete_preflighted(
    directory_descriptor: int,
    nodes: list[_DeleteNode],
    session_device: int,
    mount_identity: tuple[int, int],
) -> None:
    try:
        for node in nodes:
            current = os.stat(
                node.name,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
            if (
                not _same_identity(node.identity, current)
                or current.st_mode != node.identity.st_mode
                or current.st_dev != session_device
            ):
                raise PromotionError("private session deletion failed")
            if node.children is not None:
                child = os.open(
                    node.name,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=directory_descriptor,
                )
                try:
                    if not _same_identity(node.identity, os.fstat(child)):
                        raise PromotionError("private session deletion failed")
                    if _descriptor_mount_identity(child) != mount_identity:
                        raise PromotionError("private session deletion failed")
                    _delete_preflighted(
                        child, node.children, session_device, mount_identity
                    )
                finally:
                    os.close(child)
                os.rmdir(node.name, dir_fd=directory_descriptor)
            else:
                os.unlink(node.name, dir_fd=directory_descriptor)
    except PromotionError:
        raise
    except (OSError, MemoryError, RecursionError):
        raise PromotionError("private session deletion failed") from None


def _destroy_bound_session(
    binding: _PrivateBinding, deletion_plan: list[_DeleteNode]
) -> None:
    try:
        _assert_private_binding(binding)
        _delete_preflighted(
            binding.session_descriptor,
            deletion_plan,
            binding.session_identity.st_dev,
            binding.mount_identity,
        )
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


def _rollback_installed_fixture(
    destination: _DestinationBinding,
    fixture_id: str,
    installed_identity: os.stat_result,
) -> None:
    target_descriptor = None
    try:
        current = os.stat(
            fixture_id,
            dir_fd=destination.destination_descriptor,
            follow_symlinks=False,
        )
        if not _same_identity(installed_identity, current) or not stat.S_ISDIR(
            current.st_mode
        ):
            raise PromotionError("promotion rollback failed")
        target_descriptor = os.open(
            fixture_id,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=destination.destination_descriptor,
        )
        if not _same_identity(installed_identity, os.fstat(target_descriptor)):
            raise PromotionError("promotion rollback failed")
        _remove_tree_contents(target_descriptor)
        os.close(target_descriptor)
        target_descriptor = None
        current = os.stat(
            fixture_id,
            dir_fd=destination.destination_descriptor,
            follow_symlinks=False,
        )
        if not _same_identity(installed_identity, current):
            raise PromotionError("promotion rollback failed")
        os.rmdir(fixture_id, dir_fd=destination.destination_descriptor)
        os.fsync(destination.destination_descriptor)
    except (PromotionError, OSError, MemoryError):
        raise PromotionError("promotion rollback failed") from None
    finally:
        if target_descriptor is not None:
            os.close(target_descriptor)


def promote_candidate(candidate: Path, destination: Path, now: str | None = None) -> Path:
    """Revalidate, atomically install, then securely destroy the raw session."""

    _require_posix_capabilities(exclusive_install=True)
    binding = _open_private_binding(Path(candidate))
    destination_binding = None
    try:
        destination_binding = _open_destination_binding(Path(destination))
        _reject_overlap(binding, destination_binding)
        return _promote_bound_candidate(binding, destination_binding, now)
    finally:
        if destination_binding is not None:
            destination_binding.close()
        binding.close()


def _promote_bound_candidate(
    binding: _PrivateBinding, destination: _DestinationBinding, now: str | None
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

    snapshot = _candidate_snapshot(binding)
    fixture_bytes = snapshot["fixture.json"]
    digest = hashlib.sha256(fixture_bytes).hexdigest()
    approval = _validate_approval(
        _parse_json_bytes(snapshot["approval.json"], "invalid approval"),
        digest,
    )
    fixture = _parse_json_bytes(
        fixture_bytes, "invalid fixture artifact"
    )
    try:
        validate_fixture(fixture)
    except ContractError:
        raise PromotionError("invalid fixture artifact") from None

    semantic_bytes = _read_regular_at(
        binding.session_descriptor, "semantic.json", "invalid private inputs"
    )
    receipt_bytes = _read_regular_at(
        binding.session_descriptor, "capture-receipt.json", "invalid private inputs"
    )
    semantic = _parse_json_bytes(semantic_bytes, "invalid private inputs")
    receipt = _parse_json_bytes(receipt_bytes, "invalid private inputs")
    try:
        rebuilt = compile_capture(semantic, receipt, fixture["id"])
    except (ContractError, TypeError, ValueError):
        raise PromotionError("invalid private inputs") from None
    if rebuilt != fixture:
        raise PromotionError("fixture does not match private inputs")

    manifest = _parse_json_bytes(
        snapshot["review-manifest.json"], "invalid review manifest"
    )
    _scan_snapshot(snapshot, _denied_terms(semantic))
    _assert_private_binding(binding)
    _validate_manifest(manifest, fixture["id"])
    deletion_plan = _preflight_deletion(binding)

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

    display_destination = destination.destination
    _assert_destination_binding(destination)
    _assert_private_binding(binding)
    staging_descriptor = None
    staging_name = f".{fixture['id']}.{secrets.token_hex(8)}"
    installed_identity = None
    install_complete = False
    try:
        os.mkdir(
            staging_name, mode=0o755, dir_fd=destination.destination_descriptor
        )
        staging_descriptor = os.open(
            staging_name,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=destination.destination_descriptor,
        )
        _write_staging_file(staging_descriptor, "fixture.json", fixture_bytes)
        _write_staging_file(
            staging_descriptor, "approval.json", _json_bytes(approval)
        )
        _write_staging_file(
            staging_descriptor, "provenance.json", _json_bytes(provenance)
        )
        os.fsync(staging_descriptor)
        staging_identity = os.fstat(staging_descriptor)
        os.close(staging_descriptor)
        staging_descriptor = None
        _assert_private_binding(binding)
        _assert_destination_binding(destination)
        try:
            exclusive_rename(
                destination.destination_descriptor,
                staging_name,
                destination.destination_descriptor,
                fixture["id"],
            )
            install_complete = True
            installed_identity = staging_identity
            os.fsync(destination.destination_descriptor)
        except BrokerError as error:
            if str(error) == "destination-exists":
                raise PromotionError("destination exists") from None
            raise PromotionError("atomic install failed") from None
    except PromotionError:
        if install_complete and installed_identity is not None:
            _rollback_installed_fixture(
                destination, fixture["id"], installed_identity
            )
        raise
    except (OSError, MemoryError):
        if install_complete and installed_identity is not None:
            _rollback_installed_fixture(
                destination, fixture["id"], installed_identity
            )
        raise PromotionError("atomic install failed") from None
    finally:
        if staging_descriptor is not None:
            os.close(staging_descriptor)
        try:
            os.stat(
                staging_name,
                dir_fd=destination.destination_descriptor,
                follow_symlinks=False,
            )
        except OSError:
            pass
        else:
            try:
                _remove_child_tree(destination.destination_descriptor, staging_name)
            except (OSError, PromotionError):
                pass

    cleanup_mutated = False
    tombstone_name = f".deleting-{secrets.token_hex(12)}"
    try:
        if installed_identity is None:
            raise PromotionError("atomic install failed")
        _assert_destination_binding(destination)
        _assert_private_binding(binding)
        exclusive_rename(
            binding.private_descriptor,
            binding.session.name,
            binding.private_descriptor,
            tombstone_name,
        )
        cleanup_mutated = True
        binding.session = binding.private / tombstone_name
        os.fsync(binding.private_descriptor)
        named_tombstone = os.stat(
            tombstone_name,
            dir_fd=binding.private_descriptor,
            follow_symlinks=False,
        )
        if not _same_identity(binding.session_identity, named_tombstone):
            raise PromotionError("cleanup incomplete")
        _destroy_bound_session(binding, deletion_plan)
    except (BrokerError, OSError, PromotionError) as cleanup_error:
        if not cleanup_mutated and installed_identity is not None:
            _rollback_installed_fixture(
                destination, fixture["id"], installed_identity
            )
        raise PromotionError("cleanup incomplete") from cleanup_error
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
