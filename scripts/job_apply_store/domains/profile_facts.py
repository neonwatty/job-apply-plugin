"""Fact-group persistence methods for composed Store implementations."""

from __future__ import annotations

import uuid
from typing import Any

from ..constants import FACT_GROUP_ID
from ..errors import StoreError
from ..io import (
    atomic_write_json,
    exclusive_file_lock,
    read_json_object,
    require_object,
    validate_version,
)
from ..validation.profile_answers import (
    _fact_group_label,
    _fact_group_order,
    _fact_group_paths,
    _validate_fact_group_record,
)


class ProfileFactsStoreMixin:
    def _load_fact_groups_document(self) -> dict[str, Any]:
        runtime = self._runtime_provider()
        document = runtime.get("read_json_object", read_json_object)(
            self.fact_groups_path, "fact groups"
        )
        runtime.get("validate_version", validate_version)(document, "fact groups")
        if set(document) != {"schemaVersion", "groups", "metadata"}:
            raise StoreError("fact groups contains unsupported fields")
        require = runtime.get("_require_object", require_object)
        groups = require(document.get("groups"), "fact groups.groups")
        metadata = require(document.get("metadata"), "fact groups.metadata")
        if set(metadata) != {"createdAt", "updatedAt"}:
            raise StoreError("fact groups metadata is invalid")
        for field in ("createdAt", "updatedAt"):
            if not isinstance(metadata.get(field), str) or not metadata[field]:
                raise StoreError("fact groups metadata timestamp is invalid")
        validate_record = runtime.get(
            "_validate_fact_group_record", _validate_fact_group_record
        )
        for key, record in groups.items():
            validate_record(key, record)
        return document

    @staticmethod
    def _fact_group_sort_key(record: dict[str, Any]) -> tuple[Any, ...]:
        return (record["order"], record["label"].casefold(), record["id"])

    @staticmethod
    def _reject_fact_group_label_collision(
        groups: dict[str, Any], label: str, *, exclude_id: str | None = None
    ) -> None:
        identity = label.casefold()
        if any(
            key != exclude_id and record["label"].casefold() == identity
            for key, record in groups.items()
        ):
            raise StoreError("active fact group label already exists")

    def list_fact_groups(self) -> list[dict[str, Any]]:
        self.initialize()
        document = self._load_fact_groups_document()
        return sorted(
            (dict(record) for record in document["groups"].values()),
            key=self._fact_group_sort_key,
        )

    def get_fact_group(self, group_id: str) -> dict[str, Any] | None:
        self.initialize()
        if FACT_GROUP_ID.fullmatch(group_id or "") is None:
            raise StoreError("fact group id is invalid")
        record = self._load_fact_groups_document()["groups"].get(group_id)
        return dict(record) if record is not None else None

    def create_fact_group(self, incoming: dict[str, Any]) -> dict[str, Any]:
        runtime = self._runtime_provider()
        payload = runtime.get("_require_object", require_object)(incoming, "fact group")
        if set(payload) - {"label", "paths", "order"} or not {
            "label",
            "paths",
        } <= set(payload):
            raise StoreError("fact group requires label and paths")
        label = runtime.get("_fact_group_label", _fact_group_label)(
            payload.get("label")
        )
        paths = runtime.get("_fact_group_paths", _fact_group_paths)(
            payload.get("paths")
        )
        requested_order = payload.get("order")
        if requested_order is not None:
            requested_order = runtime.get("_fact_group_order", _fact_group_order)(
                requested_order
            )
        self.initialize()
        lock = runtime.get("exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_fact_groups_document()
            groups = document["groups"]
            self._reject_fact_group_label_collision(groups, label)
            order = requested_order
            if order is None:
                order = (
                    max(
                        (record["order"] for record in groups.values()),
                        default=-100,
                    )
                    + 100
                )
            group_id = runtime.get("uuid", uuid).uuid4().hex
            now = self._now()
            record = {
                "id": group_id,
                "label": label,
                "paths": paths,
                "order": order,
                "revision": 1,
                "createdAt": now,
                "updatedAt": now,
            }
            groups[group_id] = record
            document["metadata"]["updatedAt"] = now
            runtime.get("atomic_write_json", atomic_write_json)(
                self.fact_groups_path, document
            )
        return dict(record)

    def update_fact_group(
        self, group_id: str, patch: dict[str, Any], expected_revision: int
    ) -> dict[str, Any]:
        if FACT_GROUP_ID.fullmatch(group_id or "") is None:
            raise StoreError("fact group id is invalid")
        runtime = self._runtime_provider()
        incoming = runtime.get("_require_object", require_object)(
            patch, "fact group patch"
        )
        if not incoming or set(incoming) - {"label", "paths", "order"}:
            raise StoreError("fact group patch must contain label, paths, or order")
        if (
            not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
        ):
            raise StoreError(
                "fact group expected revision must be a positive integer"
            )
        self.initialize()
        lock = runtime.get("exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_fact_groups_document()
            groups = document["groups"]
            current = groups.get(group_id)
            if current is None:
                raise StoreError("fact group does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("fact group revision conflict")
            updated = dict(current)
            if "label" in incoming:
                updated["label"] = runtime.get(
                    "_fact_group_label", _fact_group_label
                )(incoming["label"])
                self._reject_fact_group_label_collision(
                    groups, updated["label"], exclude_id=group_id
                )
            if "paths" in incoming:
                updated["paths"] = runtime.get(
                    "_fact_group_paths", _fact_group_paths
                )(incoming["paths"])
            if "order" in incoming:
                updated["order"] = runtime.get(
                    "_fact_group_order", _fact_group_order
                )(incoming["order"])
            if all(
                updated[field] == current[field]
                for field in ("label", "paths", "order")
            ):
                return dict(current)
            now = self._now()
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = now
            groups[group_id] = updated
            document["metadata"]["updatedAt"] = now
            runtime.get("atomic_write_json", atomic_write_json)(
                self.fact_groups_path, document
            )
        return dict(updated)

    def delete_fact_group(
        self, group_id: str, expected_revision: int
    ) -> dict[str, Any]:
        if FACT_GROUP_ID.fullmatch(group_id or "") is None:
            raise StoreError("fact group id is invalid")
        if (
            not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
        ):
            raise StoreError(
                "fact group expected revision must be a positive integer"
            )
        self.initialize()
        runtime = self._runtime_provider()
        lock = runtime.get("exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_fact_groups_document()
            current = document["groups"].get(group_id)
            if current is None:
                raise StoreError("fact group does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("fact group revision conflict")
            del document["groups"][group_id]
            document["metadata"]["updatedAt"] = self._now()
            runtime.get("atomic_write_json", atomic_write_json)(
                self.fact_groups_path, document
            )
        return {"deleted": True, "id": group_id}
