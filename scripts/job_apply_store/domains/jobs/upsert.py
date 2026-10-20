"""Previewed, deterministic job upsert planning and commit behavior."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

from ...errors import StoreError


_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


def _static_owner() -> type:
    return _runtime().get("Store", JobUpsertMixin)


class JobUpsertMixin:
    """Job upsert operations composed ahead of the compatibility Store."""

    @staticmethod
    def _job_upsert_payload(payload: dict[str, Any]) -> list[Any]:
        if set(payload) != {"jobs"}:
            raise StoreError("job upsert input must contain only a jobs array")
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            raise StoreError("job upsert input.jobs must be an array")
        return jobs

    @staticmethod
    def _canonical_upsert_input(payload: dict[str, Any]) -> dict[str, Any]:
        normalized: list[Any] = []
        for value in _static_owner()._job_upsert_payload(payload):
            if not isinstance(value, dict):
                normalized.append(value)
                continue
            item: dict[str, Any] = {}
            for field, field_value in value.items():
                if isinstance(field_value, str):
                    field_value = field_value.strip()
                item[field] = field_value
            normalized.append(item)
        return {"jobs": normalized}

    @staticmethod
    def _upsert_token(
        document: dict[str, Any], payload: dict[str, Any], origin: str
    ) -> str:
        runtime = _runtime()
        bound = {
            "version": 1,
            "origin": runtime["_job_origin"](origin),
            "input": _static_owner()._canonical_upsert_input(payload),
            "jobsDocument": document,
        }
        return "job-upsert-v1." + runtime.get("hashlib", hashlib).sha256(
            runtime["_canonical_json"](bound).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _deterministic_job_id(item: dict[str, Any]) -> str:
        identity = f"url\0{item['normalizedUrl']}"
        return "job-" + _runtime().get("hashlib", hashlib).sha256(
            identity.encode("utf-8")
        ).hexdigest()[:24]

    @staticmethod
    def _normalize_upsert_item(value: Any) -> dict[str, Any]:
        runtime = _runtime()
        item = runtime["_require_object"](value, "job upsert item")
        ingest_fields = runtime["JOB_INGEST_FIELDS"]
        if set(item) - ingest_fields:
            raise StoreError("job upsert item contains unsupported fields")
        if not runtime["_nonempty_job_value"](item.get("url")):
            raise StoreError("job upsert item requires a URL")
        string_fields = ingest_fields - {"priority"}
        for field in string_fields:
            if field in item and item[field] is not None and not isinstance(
                item[field], str
            ):
                raise StoreError(f"job upsert item.{field} must be a string")
        priority = item.get("priority")
        if priority is not None and (
            not isinstance(priority, int)
            or isinstance(priority, bool)
            or not 0 <= priority <= 5
        ):
            raise StoreError("job upsert item.priority must be an integer from 0 to 5")
        normalized: dict[str, Any] = {}
        for field, field_value in item.items():
            if not runtime["_nonempty_job_value"](field_value):
                continue
            normalized[field] = (
                field_value.strip() if isinstance(field_value, str) else field_value
            )
        normalized["normalizedUrl"] = runtime["normalize_job_url"](
            normalized["url"]
        )
        normalized["url"] = normalized["url"].strip()
        if "source" in normalized:
            normalized["source"] = normalized["source"].strip()
        if "sourceId" in normalized:
            normalized["sourceId"] = normalized["sourceId"].strip()
        return normalized

    @staticmethod
    def _source_identity(record: dict[str, Any]) -> tuple[str, str] | None:
        source = _runtime()["_normalized_job_source"](record.get("source"))
        source_id = record.get("sourceId")
        if source and isinstance(source_id, str) and source_id.strip():
            return source, source_id.strip()
        return None

    def _plan_job_upsert(
        self,
        document: dict[str, Any],
        payload: dict[str, Any],
        origin: str,
        now: str,
        *,
        _allow_migration: bool = False,
        _target_ids: list[str | None] | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
        runtime = _runtime()
        if not (_allow_migration and origin == "migration"):
            origin = runtime["_job_origin"](origin)
        raw_jobs = self._job_upsert_payload(payload)
        normalized: list[dict[str, Any] | None] = []
        errors: list[str | None] = []
        for value in raw_jobs:
            try:
                normalized.append(self._normalize_upsert_item(value))
                errors.append(None)
            except StoreError as error:
                normalized.append(None)
                errors.append(str(error))

        conflict_indexes: set[int] = set()
        identities: dict[tuple[str, ...], list[int]] = {}
        for index, item in enumerate(normalized):
            if item is None:
                continue
            keys = [("url", item["normalizedUrl"])]
            source_identity = self._source_identity(item)
            if source_identity is not None:
                keys.append(("source", *source_identity))
            for key in keys:
                identities.setdefault(key, []).append(index)
        for indexes in identities.values():
            canonical = {
                runtime["_canonical_json"](normalized[index]) for index in indexes
            }
            if len(canonical) > 1:
                conflict_indexes.update(indexes)

        simulated = runtime.get("json", json).loads(
            runtime.get("json", json).dumps(document)
        )
        decisions: list[dict[str, Any]] = []
        changed_document = False
        for index, item in enumerate(normalized):
            if item is None:
                decisions.append(
                    {"index": index, "action": "invalid", "reason": errors[index]}
                )
                continue
            if index in conflict_indexes:
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "reason": "differing duplicate identities in input",
                    }
                )
                continue

            jobs = simulated["jobs"]
            target_id = _target_ids[index] if _target_ids is not None else None
            target_matches = (
                [jobs[target_id]] if target_id is not None and target_id in jobs else []
            )
            url_matches = [
                record
                for record in jobs.values()
                if record.get("normalizedUrl") == item["normalizedUrl"]
            ]
            source_identity = self._source_identity(item)
            source_matches = (
                [
                    record
                    for record in jobs.values()
                    if self._source_identity(record) == source_identity
                ]
                if source_identity is not None
                else []
            )
            matches = {
                record["id"]: record
                for record in url_matches + source_matches + target_matches
            }
            if (
                len(url_matches) > 1
                or len(source_matches) > 1
                or len(matches) > 1
                or any(record.get("deletedAt") is not None for record in matches.values())
            ):
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "reason": "job identities do not resolve to one active record",
                    }
                )
                continue

            current = next(iter(matches.values()), None)
            if current is not None:
                provenance = runtime["_require_object"](
                    current.get("provenance", {}), "job provenance"
                )
                current_source = self._source_identity(current)
                source_changed = (
                    runtime["_nonempty_job_value"](current.get("source"))
                    and runtime["_nonempty_job_value"](item.get("source"))
                    and runtime["_normalized_job_source"](current.get("source"))
                    != runtime["_normalized_job_source"](item.get("source"))
                )
                source_id_changed = (
                    runtime["_nonempty_job_value"](current.get("sourceId"))
                    and runtime["_nonempty_job_value"](item.get("sourceId"))
                    and current.get("sourceId", "").strip()
                    != item.get("sourceId", "").strip()
                )
                migration_identity_refresh = origin == "migration" and (
                    current.get("normalizedUrl") == item["normalizedUrl"]
                    or target_id == current["id"]
                )
                migration_url_refresh = (
                    origin == "migration"
                    and target_id == current["id"]
                    and runtime["_migration_may_update_job_field"](
                        current, provenance, "url"
                    )
                )
                if (
                    (
                        current.get("normalizedUrl") != item["normalizedUrl"]
                        and not migration_url_refresh
                    )
                    or (
                        (
                            current_source is not None
                            and source_identity is not None
                            and current_source != source_identity
                        )
                        or source_changed
                        or source_id_changed
                    )
                    and not migration_identity_refresh
                ):
                    decisions.append(
                        {
                            "index": index,
                            "action": "conflict",
                            "id": current["id"],
                            "reason": "incoming identity is incompatible with stored identity",
                        }
                    )
                    continue
                accepted: dict[str, Any] = {}
                for field in runtime["JOB_INGEST_FIELDS"]:
                    if field not in item or (
                        field == "url" and not migration_url_refresh
                    ):
                        continue
                    value = item[field]
                    if origin == "agent" and not runtime[
                        "_agent_may_update_job_field"
                    ](current, provenance, field):
                        continue
                    if origin == "migration" and not runtime[
                        "_migration_may_update_job_field"
                    ](current, provenance, field):
                        continue
                    if current.get(field) != value:
                        accepted[field] = value
                if not accepted:
                    decisions.append(
                        {"index": index, "action": "noop", "id": current["id"]}
                    )
                    continue
                updated = {**current, **accepted}
                if "url" in accepted:
                    updated["normalizedUrl"] = item["normalizedUrl"]
                updated["provenance"] = runtime["_stamp_job_provenance"](
                    provenance,
                    list(accepted),
                    origin,
                    runtime["_job_observation_source"](updated),
                    now,
                )
                updated["revision"] = current["revision"] + 1
                updated["updatedAt"] = now
                runtime["_validate_job_record"](current["id"], updated)
                jobs[current["id"]] = updated
                decisions.append(
                    {
                        "index": index,
                        "action": "update",
                        "id": current["id"],
                        "fields": sorted(accepted),
                    }
                )
                changed_document = True
                continue

            job_id = self._deterministic_job_id(item)
            if job_id in jobs:
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "id": job_id,
                        "reason": "deterministic job id is already in use",
                    }
                )
                continue
            incoming = {
                key: value for key, value in item.items() if key != "normalizedUrl"
            }
            fields = [
                field for field in runtime["JOB_INGEST_FIELDS"] if field in incoming
            ]
            record = {
                **incoming,
                "id": job_id,
                "normalizedUrl": item["normalizedUrl"],
                "priority": incoming.get("priority", 0),
                "status": "saved",
                "closedOutcome": None,
                "provenance": runtime["_stamp_job_provenance"](
                    {},
                    fields,
                    origin,
                    runtime["_job_observation_source"](incoming),
                    now,
                ),
                "revision": 1,
                "createdAt": now,
                "updatedAt": now,
                "deletedAt": None,
            }
            try:
                runtime["_validate_job_record"](job_id, record)
            except StoreError as error:
                decisions.append(
                    {"index": index, "action": "invalid", "reason": str(error)}
                )
                continue
            jobs[job_id] = record
            decisions.append({"index": index, "action": "create", "id": job_id})
            changed_document = True

        if changed_document:
            simulated["metadata"]["updatedAt"] = now
        return simulated, decisions, changed_document

    @staticmethod
    def _upsert_result(
        token: str, decisions: list[dict[str, Any]], committed: bool
    ) -> dict[str, Any]:
        counts = {
            action: 0
            for action in ("create", "update", "noop", "conflict", "invalid")
        }
        for decision in decisions:
            counts[decision["action"]] += 1
        return {
            "token": token,
            "summary": counts,
            "decisions": decisions,
            "committed": committed,
        }

    def preview_job_upsert(
        self, payload: dict[str, Any], origin: str
    ) -> dict[str, Any]:
        runtime = _runtime()
        document = self._load_jobs_document()
        token = self._upsert_token(document, payload, origin)
        _, decisions, _ = self._plan_job_upsert(
            document, payload, origin, runtime["utc_now"]()
        )
        return self._upsert_result(token, decisions, committed=False)

    def commit_job_upsert(
        self, payload: dict[str, Any], origin: str, token: str
    ) -> dict[str, Any]:
        if not isinstance(token, str) or not token:
            raise StoreError("job upsert commit requires a preview token")
        runtime = _runtime()
        with runtime["exclusive_file_lock"](self.store_lock_path):
            document = self._load_jobs_document()
            expected = self._upsert_token(document, payload, origin)
            if not runtime.get("hmac", hmac).compare_digest(token, expected):
                raise StoreError(
                    "job upsert preview token rejected because the store or input drifted"
                )
            planned, decisions, changed = self._plan_job_upsert(
                document, payload, origin, runtime["utc_now"]()
            )
            if changed:
                runtime["atomic_write_json"](self.jobs_path, planned)
        return self._upsert_result(token, decisions, committed=changed)
