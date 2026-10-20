"""Pure profile fact-group and remembered-answer record validation."""

from __future__ import annotations

import re
from typing import Any

from ..constants import (
    ANSWER_REVIEW_STATUSES,
    ANSWER_STATES,
    FACT_GROUP_ID,
    FACT_GROUP_MAX_PATHS,
    SENSITIVITY_LEVELS,
)
from ..errors import StoreError
from ..io import require_object
from ..normalization import _decode_json_pointer, _validate_optional_strings


def _fact_group_label(value: Any) -> str:
    if not isinstance(value, str):
        raise StoreError("fact group label must be a string")
    label = value.strip()
    if not label or len(label) > 80 or any(ord(char) < 32 for char in label):
        raise StoreError("fact group label must contain 1 to 80 printable characters")
    return label


def _fact_group_paths(value: Any) -> list[str]:
    if (
        not isinstance(value, list)
        or not value
        or len(value) > FACT_GROUP_MAX_PATHS
        or not all(isinstance(path, str) for path in value)
        or len(set(value)) != len(value)
    ):
        raise StoreError(
            f"fact group paths must contain 1 to {FACT_GROUP_MAX_PATHS} unique JSON pointers"
        )
    for path in value:
        try:
            _decode_json_pointer(path)
        except StoreError:
            raise StoreError("fact group path is invalid") from None
    return list(value)


def _fact_group_order(value: Any) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > 1_000_000
    ):
        raise StoreError("fact group order must be an integer between 0 and 1000000")
    return value


def _validate_fact_group_record(group_id: str, value: Any) -> dict[str, Any]:
    if not isinstance(group_id, str) or FACT_GROUP_ID.fullmatch(group_id) is None:
        raise StoreError("fact group id is invalid")
    record = require_object(value, "fact group record")
    expected = {"id", "label", "paths", "order", "revision", "createdAt", "updatedAt"}
    if set(record) != expected or record.get("id") != group_id:
        raise StoreError("fact group record is invalid")
    _fact_group_label(record.get("label"))
    _fact_group_paths(record.get("paths"))
    _fact_group_order(record.get("order"))
    revision = record.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("fact group revision must be a positive integer")
    for field in ("createdAt", "updatedAt"):
        if not isinstance(record.get(field), str) or not record[field]:
            raise StoreError("fact group timestamp is invalid")
    return record


def _validate_answer_record(key: str, value: Any) -> dict[str, Any]:
    record = require_object(value, "answer record")
    if record.get("key") != key:
        raise StoreError("answer record key does not match its index")
    if record.get("state") not in ANSWER_STATES:
        raise StoreError("answer record state is unsupported")
    review_status = record.get("reviewStatus", "accepted")
    if not isinstance(review_status, str) or review_status not in ANSWER_REVIEW_STATUSES:
        raise StoreError("answer record review status is unsupported")
    sensitivity = record.get("sensitivity", "none")
    if sensitivity not in SENSITIVITY_LEVELS:
        raise StoreError("answer record sensitivity is unsupported")
    field_class = record.get("fieldClass", "general")
    if not isinstance(field_class, str) or re.fullmatch(
        r"[a-z][a-z0-9_]{0,63}", field_class
    ) is None:
        raise StoreError("answer record field class is invalid")
    question = record.get("question")
    if question is not None and not isinstance(question, str):
        raise StoreError("answer record question must be a string")
    aliases = record.get("aliases", [])
    if not isinstance(aliases, list) or not all(isinstance(alias, str) for alias in aliases):
        raise StoreError("answer record aliases must be strings")
    require_object(record.get("scope", {}), "answer record scope")
    value_present = record.get("value") is not None
    if record["state"] == "confirmed" and not value_present:
        raise StoreError("confirmed answer record has no value")
    if record["state"] == "missing" and value_present:
        raise StoreError("missing answer record contains a value")
    if value_present and (record["state"] == "sensitive" or sensitivity != "none"):
        consent = record.get("rememberedWithConsentAt")
        if not isinstance(consent, str) or not consent:
            raise StoreError("sensitive answer record has no remember consent marker")
    _validate_optional_strings(
        record,
        {
            "source", "confirmedAt", "createdAt", "updatedAt",
            "rememberedWithConsentAt", "deletedAt", "observedAt",
            "lastObservedAt", "reviewedAt",
        },
        "answer record",
    )
    revision = record.get("revision", 1)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("answer revision must be a positive integer")
    observation_count = record.get("observationCount", 0)
    if (
        not isinstance(observation_count, int)
        or isinstance(observation_count, bool)
        or observation_count < 0
    ):
        raise StoreError("answer observation count must be a non-negative integer")
    return record


def _validate_answer_redirects(redirects: Any, answers: dict[str, Any]) -> dict[str, Any]:
    records = require_object(redirects, "answer redirects")
    for source_key, raw in records.items():
        if not isinstance(source_key, str) or not source_key:
            raise StoreError("answer redirect source is invalid")
        redirect = require_object(raw, "answer redirect")
        if set(redirect) != {"targetKey", "mergedAt"}:
            raise StoreError("answer redirect contains unsupported fields")
        target_key = redirect.get("targetKey")
        if (
            not isinstance(target_key, str)
            or not target_key
            or target_key == source_key
            or source_key in answers
            or target_key not in answers
            or answers[target_key].get("deletedAt") is not None
            or target_key in records
        ):
            raise StoreError("answer redirect is not flattened to an active answer")
        if not isinstance(redirect.get("mergedAt"), str) or not redirect["mergedAt"]:
            raise StoreError("answer redirect timestamp is invalid")
    return records
