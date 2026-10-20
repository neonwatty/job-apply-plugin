"""Pure job and resume registry record validation."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from ..constants import JOB_CLOSED_OUTCOMES, JOB_STATUSES, RESUME_MEDIA_TYPES
from ..errors import StoreError
from ..io import require_object
from ..normalization import (
    _safe_session_id,
    _validate_optional_strings,
    normalize_job_url,
    normalize_resume_path,
)


def _validate_job_record(
    key: str, value: Any, *, path_type: type[Path] = Path,
) -> dict[str, Any]:
    record = require_object(value, "job record")
    allowed = {
        "id",
        "url",
        "normalizedUrl",
        "source",
        "sourceId",
        "role",
        "company",
        "location",
        "workplaceType",
        "employmentType",
        "compensation",
        "description",
        "ats",
        "priority",
        "status",
        "closedOutcome",
        "resumeId",
        "notes",
        "provenance",
        "legacySources",
        "lastCheckedAt",
        "revision",
        "createdAt",
        "updatedAt",
        "deletedAt",
    }
    if set(record) - allowed:
        raise StoreError("job record contains unsupported fields")
    if record.get("id") != key:
        raise StoreError("job record id does not match its index")
    _safe_session_id(key)
    normalized = normalize_job_url(record.get("url", ""))
    if record.get("normalizedUrl") != normalized:
        raise StoreError("job record normalized URL does not match")
    if record.get("status") not in JOB_STATUSES:
        raise StoreError("job status is unsupported")
    closed_outcome = record.get("closedOutcome")
    if record["status"] == "closed":
        if closed_outcome not in JOB_CLOSED_OUTCOMES:
            raise StoreError("closed job requires a supported outcome")
    elif closed_outcome is not None:
        raise StoreError("open job cannot have a closed outcome")
    priority = record.get("priority", 0)
    if (
        not isinstance(priority, int)
        or isinstance(priority, bool)
        or not 0 <= priority <= 5
    ):
        raise StoreError("job priority must be an integer from 0 to 5")
    revision = record.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("job revision must be a positive integer")
    provenance = record.get("provenance", {})
    require_object(provenance, "job provenance")
    legacy_sources = record.get("legacySources", [])
    if not isinstance(legacy_sources, list):
        raise StoreError("job legacySources must be an array")
    for source in legacy_sources:
        source = require_object(source, "job legacy source")
        if set(source) != {"sourceKind", "relativePath", "entryId", "sourceSha256"}:
            raise StoreError("job legacy source contains unsupported fields")
        if source.get("sourceKind") != "timestamped-search-report":
            raise StoreError("job legacy source kind is unsupported")
        relative_path = source.get("relativePath")
        if (
            not isinstance(relative_path, str)
            or not relative_path
            or path_type(relative_path).name != relative_path
            or not relative_path.startswith("search-")
            or not relative_path.endswith(".md")
        ):
            raise StoreError("job legacy source path is invalid")
        if not isinstance(source.get("entryId"), str) or not re.fullmatch(
            r"legacy-entry-[0-9a-f]{24}", source["entryId"]
        ):
            raise StoreError("job legacy source entry id is invalid")
        if not isinstance(source.get("sourceSha256"), str) or not re.fullmatch(
            r"[0-9a-f]{64}", source["sourceSha256"]
        ):
            raise StoreError("job legacy source digest is invalid")
    _validate_optional_strings(
        record,
        {
            "url",
            "normalizedUrl",
            "source",
            "sourceId",
            "role",
            "company",
            "location",
            "workplaceType",
            "employmentType",
            "compensation",
            "description",
            "ats",
            "closedOutcome",
            "resumeId",
            "notes",
            "lastCheckedAt",
            "createdAt",
            "updatedAt",
            "deletedAt",
        },
        "job record",
    )
    if not isinstance(record.get("createdAt"), str) or not record["createdAt"]:
        raise StoreError("job record has no creation timestamp")
    if not isinstance(record.get("updatedAt"), str) or not record["updatedAt"]:
        raise StoreError("job record has no update timestamp")
    return record


def _validate_resume_record(
    key: str,
    value: Any,
    *,
    path_type: type[Path] = Path,
    os_module: Any = os,
    trusted_fill_module: Any,
) -> dict[str, Any]:
    record = require_object(value, "resume record")
    allowed = {
        "id",
        "label",
        "path",
        "storageKind",
        "managedFile",
        "originalFilename",
        "mediaType",
        "digest",
        "contentRevision",
        "tags",
        "default",
        "observedSize",
        "observedModifiedAt",
        "revision",
        "createdAt",
        "updatedAt",
        "deletedAt",
    }
    if set(record) - allowed:
        raise StoreError("resume record contains unsupported fields")
    if record.get("id") != key:
        raise StoreError("resume record id does not match its index")
    _safe_session_id(key)
    if not isinstance(record.get("label"), str) or not record["label"].strip():
        raise StoreError("resume label must be a non-empty string")
    storage_kind = record.get("storageKind")
    if storage_kind is None:
        if record.get("path") != normalize_resume_path(
            record.get("path", ""),
            _runtime={"Path": path_type, "os": os_module},
        ):
            raise StoreError("resume path is not normalized")
        if any(
            field in record
            for field in (
                "managedFile", "originalFilename", "mediaType", "digest",
                "contentRevision",
            )
        ):
            raise StoreError("legacy resume record contains managed storage fields")
    elif storage_kind == "managed":
        if "path" in record:
            raise StoreError("managed resume record must not contain a source path")
        managed_file = record.get("managedFile")
        expected_names = {f"{key}{extension}" for extension in RESUME_MEDIA_TYPES}
        if not isinstance(managed_file, str) or managed_file not in expected_names:
            raise StoreError("managed resume file identity is invalid")
        original_filename = record.get("originalFilename")
        if (
            not isinstance(original_filename, str)
            or not original_filename
            or path_type(original_filename).name != original_filename
            or "\0" in original_filename
        ):
            raise StoreError("managed resume original filename is invalid")
        extension = path_type(managed_file).suffix.lower()
        if record.get("mediaType") != RESUME_MEDIA_TYPES[extension]:
            raise StoreError("managed resume media type is invalid")
        digest = record.get("digest")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise StoreError("managed resume digest is invalid")
        content_revision = record.get("contentRevision")
        if content_revision is not None:
            try:
                trusted_fill_module.validate_content_revision(content_revision)
            except trusted_fill_module.TrustedFillError as error:
                raise StoreError(str(error)) from None
        if record.get("observedSize") is None or not record.get("observedModifiedAt"):
            raise StoreError("managed resume observation is incomplete")
    else:
        raise StoreError("resume storage kind is unsupported")
    tags = record.get("tags", [])
    if not isinstance(tags, list) or not all(
        isinstance(item, str) and item.strip() for item in tags
    ):
        raise StoreError("resume tags must be non-empty strings")
    if len(set(tags)) != len(tags):
        raise StoreError("resume tags must be unique")
    if not isinstance(record.get("default"), bool):
        raise StoreError("resume default must be a boolean")
    observed_size = record.get("observedSize")
    if observed_size is not None and (
        not isinstance(observed_size, int)
        or isinstance(observed_size, bool)
        or observed_size < 0
    ):
        raise StoreError("resume observed size is invalid")
    revision = record.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("resume revision must be a positive integer")
    _validate_optional_strings(
        record,
        {"observedModifiedAt", "createdAt", "updatedAt", "deletedAt"},
        "resume record",
    )
    if not isinstance(record.get("createdAt"), str) or not record["createdAt"]:
        raise StoreError("resume record has no creation timestamp")
    if not isinstance(record.get("updatedAt"), str) or not record["updatedAt"]:
        raise StoreError("resume record has no update timestamp")
    return record
