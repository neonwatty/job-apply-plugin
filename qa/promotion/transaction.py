"""Descriptor-bound fixture promotion transaction."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import secrets
import sys
from typing import Any

from qa.compiler import COMPILER_VERSION, compile_capture
from qa.contracts import ContractError, validate_fixture
from qa.recorder_fs import BrokerError, exclusive_rename
from qa.promotion.approval import (
    PROMOTION_SCHEMA_VERSION,
    SCANNER_VERSION,
    _timestamp,
    _validate_approval,
)
from qa.promotion.bindings import (
    PromotionError,
    _PrivateBinding,
    _assert_private_binding,
    _json_bytes,
    _open_private_binding,
    _parse_json_bytes,
    _read_regular_at,
    _require_posix_capabilities,
    _same_identity,
)
from qa.promotion.candidate import (
    _candidate_snapshot,
    _denied_terms,
    _scan_snapshot,
    _validate_manifest,
)
from qa.promotion.deletion import (
    _destroy_bound_session,
    _preflight_deletion,
    _remove_child_tree,
)
from qa.promotion.destination import (
    _DestinationBinding,
    _assert_destination_binding,
    _open_destination_binding,
    _reject_overlap,
    _write_staging_file,
)
from qa.promotion.rollback import _rollback_installed_fixture


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


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def promote_candidate(
    candidate: Path,
    destination: Path,
    now: str | None = None,
    *,
    _runtime: Any | None = None,
) -> Path:
    """Revalidate, atomically install, then destroy the raw session."""

    runtime = _resolve_runtime(_runtime)
    runtime._require_posix_capabilities(exclusive_install=True)
    binding = runtime._open_private_binding(runtime.Path(candidate))
    destination_binding = None
    try:
        destination_binding = runtime._open_destination_binding(
            runtime.Path(destination)
        )
        runtime._reject_overlap(binding, destination_binding)
        return runtime._promote_bound_candidate(binding, destination_binding, now)
    finally:
        if destination_binding is not None:
            destination_binding.close()
        binding.close()


def _promote_bound_candidate(
    binding: _PrivateBinding,
    destination: _DestinationBinding,
    now: str | None,
    *,
    _runtime: Any | None = None,
) -> Path:
    runtime = _resolve_runtime(_runtime)
    runtime._assert_private_binding(binding)
    try:
        runtime.os.stat(
            "approval.json",
            dir_fd=binding.candidate_descriptor,
            follow_symlinks=False,
        )
    except OSError:
        raise PromotionError("approval required") from None

    snapshot = runtime._candidate_snapshot(binding)
    fixture_bytes = snapshot["fixture.json"]
    digest = runtime.hashlib.sha256(fixture_bytes).hexdigest()
    approval = runtime._validate_approval(
        runtime._parse_json_bytes(snapshot["approval.json"], "invalid approval"),
        digest,
    )
    fixture = runtime._parse_json_bytes(
        fixture_bytes, "invalid fixture artifact"
    )
    try:
        runtime.validate_fixture(fixture)
    except ContractError:
        raise PromotionError("invalid fixture artifact") from None

    semantic_bytes = runtime._read_regular_at(
        binding.session_descriptor, "semantic.json", "invalid private inputs"
    )
    receipt_bytes = runtime._read_regular_at(
        binding.session_descriptor,
        "capture-receipt.json",
        "invalid private inputs",
    )
    semantic = runtime._parse_json_bytes(semantic_bytes, "invalid private inputs")
    receipt = runtime._parse_json_bytes(receipt_bytes, "invalid private inputs")
    try:
        rebuilt = runtime.compile_capture(semantic, receipt, fixture["id"])
    except (ContractError, TypeError, ValueError):
        raise PromotionError("invalid private inputs") from None
    if rebuilt != fixture:
        raise PromotionError("fixture does not match private inputs")

    manifest = runtime._parse_json_bytes(
        snapshot["review-manifest.json"], "invalid review manifest"
    )
    runtime._scan_snapshot(snapshot, runtime._denied_terms(semantic))
    runtime._assert_private_binding(binding)
    runtime._validate_manifest(manifest, fixture["id"])
    deletion_plan = runtime._preflight_deletion(binding)

    promoted_at = runtime._timestamp(now)
    provenance = {
        "schemaVersion": runtime.PROMOTION_SCHEMA_VERSION,
        "fixtureId": fixture["id"],
        "platformFamily": fixture["platformFamily"],
        "captureMonth": fixture["captureMonth"],
        "recorderVersion": fixture["provenance"]["recorderVersion"],
        "compilerVersion": runtime.COMPILER_VERSION,
        "scannerVersion": runtime.SCANNER_VERSION,
        "sourceRecordingSha256": fixture["provenance"][
            "sourceRecordingSha256"
        ],
        "fixtureSha256": digest,
        "approvedBy": approval["reviewer"],
        "approvedAt": approval["approvedAt"],
        "promotedAt": promoted_at,
    }
    if set(provenance) != runtime.PROVENANCE_KEYS:
        raise PromotionError("invalid provenance")

    display_destination = destination.destination
    runtime._assert_destination_binding(destination)
    runtime._assert_private_binding(binding)
    staging_descriptor = None
    staging_name = f".{fixture['id']}.{runtime.secrets.token_hex(8)}"
    installed_identity = None
    install_complete = False
    try:
        runtime.os.mkdir(
            staging_name,
            mode=0o755,
            dir_fd=destination.destination_descriptor,
        )
        staging_descriptor = runtime.os.open(
            staging_name,
            runtime.os.O_RDONLY
            | runtime.os.O_DIRECTORY
            | runtime.os.O_NOFOLLOW
            | runtime.os.O_CLOEXEC,
            dir_fd=destination.destination_descriptor,
        )
        runtime._write_staging_file(
            staging_descriptor, "fixture.json", fixture_bytes
        )
        runtime._write_staging_file(
            staging_descriptor, "approval.json", runtime._json_bytes(approval)
        )
        runtime._write_staging_file(
            staging_descriptor,
            "provenance.json",
            runtime._json_bytes(provenance),
        )
        runtime.os.fsync(staging_descriptor)
        staging_identity = runtime.os.fstat(staging_descriptor)
        runtime.os.close(staging_descriptor)
        staging_descriptor = None
        runtime._assert_private_binding(binding)
        runtime._assert_destination_binding(destination)
        try:
            runtime.exclusive_rename(
                destination.destination_descriptor,
                staging_name,
                destination.destination_descriptor,
                fixture["id"],
            )
            install_complete = True
            installed_identity = staging_identity
            runtime.os.fsync(destination.destination_descriptor)
        except BrokerError as error:
            if str(error) == "destination-exists":
                raise PromotionError("destination exists") from None
            raise PromotionError("atomic install failed") from None
    except PromotionError:
        if install_complete and installed_identity is not None:
            runtime._rollback_installed_fixture(
                destination, fixture["id"], installed_identity
            )
        raise
    except (OSError, MemoryError):
        if install_complete and installed_identity is not None:
            runtime._rollback_installed_fixture(
                destination, fixture["id"], installed_identity
            )
        raise PromotionError("atomic install failed") from None
    finally:
        if staging_descriptor is not None:
            runtime.os.close(staging_descriptor)
        try:
            runtime.os.stat(
                staging_name,
                dir_fd=destination.destination_descriptor,
                follow_symlinks=False,
            )
        except OSError:
            pass
        else:
            try:
                runtime._remove_child_tree(
                    destination.destination_descriptor, staging_name
                )
            except (OSError, PromotionError):
                pass

    cleanup_mutated = False
    tombstone_name = f".deleting-{runtime.secrets.token_hex(12)}"
    try:
        if installed_identity is None:
            raise PromotionError("atomic install failed")
        runtime._assert_destination_binding(destination)
        runtime._assert_private_binding(binding)
        runtime.exclusive_rename(
            binding.private_descriptor,
            binding.session.name,
            binding.private_descriptor,
            tombstone_name,
        )
        cleanup_mutated = True
        binding.session = binding.private / tombstone_name
        runtime.os.fsync(binding.private_descriptor)
        named_tombstone = runtime.os.stat(
            tombstone_name,
            dir_fd=binding.private_descriptor,
            follow_symlinks=False,
        )
        if not runtime._same_identity(binding.session_identity, named_tombstone):
            raise PromotionError("cleanup incomplete")
        runtime._destroy_bound_session(binding, deletion_plan)
    except (BrokerError, OSError, PromotionError) as cleanup_error:
        if not cleanup_mutated and installed_identity is not None:
            runtime._rollback_installed_fixture(
                destination, fixture["id"], installed_identity
            )
        raise PromotionError("cleanup incomplete") from cleanup_error
    return display_destination / fixture["id"]
