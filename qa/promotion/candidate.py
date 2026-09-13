"""Candidate compilation, snapshotting, and privacy scanning."""

from __future__ import annotations

import os
from pathlib import Path
import stat
import sys
import tempfile
from typing import Any

from qa.compiler import compile_capture
from qa.contracts import ContractError
from qa.privacy import (
    MAX_DENIED_TERM_CHARS,
    MAX_DENIED_TERMS,
    PrivacyError,
    scan_tree,
)
from qa.promotion.bindings import (
    PromotionError,
    _PrivateBinding,
    _assert_private_binding,
    _atomic_write_at,
    _darwin_mountpoint_bound,
    _descriptor_mount_identity,
    _json_bytes,
    _open_session_binding,
    _read_json_at,
    _read_regular_at,
    _require_posix_capabilities,
    _require_private_permissions,
    _same_identity,
)
from qa.promotion.deletion import _remove_child_tree


PROMOTION_SCHEMA_VERSION = 1
MANIFEST_KEYS = {"schemaVersion", "fixtureId", "paths", "stringCategories"}
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


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _candidate_snapshot(
    binding: _PrivateBinding, *, _runtime: Any | None = None
) -> dict[str, bytes]:
    runtime = _resolve_runtime(_runtime)
    expected = {"fixture.json", "review-manifest.json", "approval.json"}
    names: set[str] = set()
    try:
        with runtime.os.scandir(binding.candidate_descriptor) as entries:
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
        name: runtime._read_regular_at(
            binding.candidate_descriptor, name, "invalid candidate artifact"
        )
        for name in sorted(expected)
    }


def _scan_snapshot(
    snapshot: dict[str, bytes],
    denied_terms: list[str],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        with runtime.tempfile.TemporaryDirectory(
            prefix="qa-promotion-scan-"
        ) as temporary:
            root = runtime.Path(temporary)
            for name, data in snapshot.items():
                (root / name).write_bytes(data)
            runtime.scan_tree(root, denied_terms)
    except PrivacyError:
        raise PromotionError("privacy scan failed") from None
    except (OSError, MemoryError):
        raise PromotionError("privacy scan failed") from None


def _denied_terms(semantic: Any, *, _runtime: Any | None = None) -> list[str]:
    runtime = _resolve_runtime(_runtime)
    if not isinstance(semantic, dict):
        raise PromotionError("invalid private inputs")
    terms = semantic.get("sourceDeniedTerms")
    if (
        not isinstance(terms, list)
        or len(terms) > runtime.MAX_DENIED_TERMS
        or any(
            not isinstance(term, str) or len(term) > runtime.MAX_DENIED_TERM_CHARS
            for term in terms
        )
    ):
        raise PromotionError("invalid private inputs")
    return terms


def _validate_manifest(
    value: Any, fixture_id: str, *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    if (
        not isinstance(value, dict)
        or set(value) != runtime.MANIFEST_KEYS
        or value.get("schemaVersion") != runtime.PROMOTION_SCHEMA_VERSION
        or isinstance(value.get("schemaVersion"), bool)
        or value.get("fixtureId") != fixture_id
        or value.get("paths") != runtime.MANIFEST_PATHS
        or value.get("stringCategories") != runtime.MANIFEST_STRING_CATEGORIES
    ):
        raise PromotionError("invalid review manifest")


def compile_candidate(
    capture: Path,
    fixture_id: str,
    candidate: Path,
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    """Compile the two permitted private inputs into a review candidate."""

    runtime = _resolve_runtime(_runtime)
    runtime._require_posix_capabilities()
    session_binding = runtime._open_session_binding(runtime.Path(capture))
    lexical_candidate = runtime.Path(runtime.os.path.abspath(candidate))
    candidate_descriptor = None
    binding = None
    created = False
    try:
        if lexical_candidate != session_binding.session / "candidate":
            raise PromotionError("unsafe candidate path")
        try:
            runtime.os.stat(
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

        semantic = runtime._read_json_at(
            session_binding.session_descriptor,
            "semantic.json",
            "invalid private inputs",
        )
        receipt = runtime._read_json_at(
            session_binding.session_descriptor,
            "capture-receipt.json",
            "invalid private inputs",
        )
        try:
            fixture = runtime.compile_capture(semantic, receipt, fixture_id)
        except (ContractError, TypeError, ValueError):
            raise PromotionError("candidate compilation failed") from None

        try:
            runtime.os.mkdir(
                "candidate", mode=0o700, dir_fd=session_binding.session_descriptor
            )
            created = True
            candidate_identity = runtime.os.stat(
                "candidate",
                dir_fd=session_binding.session_descriptor,
                follow_symlinks=False,
            )
            candidate_descriptor = runtime.os.open(
                "candidate",
                runtime.os.O_RDONLY
                | runtime.os.O_DIRECTORY
                | runtime.os.O_NOFOLLOW,
                dir_fd=session_binding.session_descriptor,
            )
        except OSError:
            raise PromotionError("candidate creation failed") from None
        if not runtime._same_identity(
            candidate_identity, runtime.os.fstat(candidate_descriptor)
        ):
            raise PromotionError("private session changed")
        runtime._require_private_permissions(candidate_identity)
        if (
            candidate_identity.st_dev != session_binding.session_identity.st_dev
            or runtime._descriptor_mount_identity(candidate_descriptor)
            != session_binding.mount_identity
            or runtime._darwin_mountpoint_bound(
                lexical_candidate, candidate_identity, candidate_descriptor
            )
        ):
            raise PromotionError("unsafe mount boundary")
        binding = runtime._PrivateBinding(
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
        fixture_output = runtime._json_bytes(fixture)
        runtime._atomic_write_at(
            binding.candidate_descriptor, "fixture.json", fixture_output
        )
        manifest = {
            "schemaVersion": runtime.PROMOTION_SCHEMA_VERSION,
            "fixtureId": fixture["id"],
            "paths": list(runtime.MANIFEST_PATHS),
            "stringCategories": list(runtime.MANIFEST_STRING_CATEGORIES),
        }
        manifest_output = runtime._json_bytes(manifest)
        runtime._atomic_write_at(
            binding.candidate_descriptor,
            "review-manifest.json",
            manifest_output,
        )
        runtime._scan_snapshot(
            {
                "fixture.json": fixture_output,
                "review-manifest.json": manifest_output,
            },
            runtime._denied_terms(semantic),
        )
        runtime._assert_private_binding(binding)
        return fixture
    except (OSError, PromotionError) as error:
        if created and binding is not None:
            try:
                runtime._assert_private_binding(binding)
                runtime._remove_child_tree(
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
                runtime.os.close(candidate_descriptor)
            session_binding.close()
