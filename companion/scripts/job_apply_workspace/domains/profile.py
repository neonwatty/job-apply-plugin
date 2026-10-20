"""Profile and fact-group mutation routes."""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from .. import runtime


class ProfileMutationMixin:
    def _mutate_profile(
        self, method: str, path: str, parts: list[str], payload: dict[str, Any]
    ) -> bool:
        store = self.server.store
        store_module = runtime()["STORE_MODULE"]
        if method == "PATCH" and path == "/api/profile":
            allowed = {"patch", "expectedRevision", "atomicPaths", "deletedPaths"}
            atomic_paths = payload.get("atomicPaths", [])
            deleted_paths = payload.get("deletedPaths", [])
            if (
                set(payload) - allowed
                or not {"patch", "expectedRevision"} <= set(payload)
                or not isinstance(payload.get("patch"), dict)
                or not payload["patch"]
                or not isinstance(atomic_paths, list)
                or not all(isinstance(item, str) for item in atomic_paths)
                or not isinstance(deleted_paths, list)
                or not all(isinstance(item, str) for item in deleted_paths)
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body requires a non-empty patch object, expectedRevision, and valid path lists",
                )
                return True
            try:
                atomic_keys = {
                    store_module._top_level_pointer_key(item) for item in atomic_paths
                }
            except store_module.StoreError as error:
                self._error(HTTPStatus.BAD_REQUEST, str(error))
                return True
            if (
                len(set(atomic_paths)) != len(atomic_paths)
                or len(set(deleted_paths)) != len(deleted_paths)
                or not set(deleted_paths) <= set(atomic_paths)
                or atomic_keys & store_module.PROFILE_NAMED_TOP_LEVEL
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "atomic paths must uniquely identify Additional facts and include every deletion",
                )
                return True
            revision = self._expected_revision(payload)
            if revision is not None:
                self._store_call(
                    lambda: store.patch_profile(
                        payload["patch"],
                        revision,
                        source="user",
                        atomic_paths=atomic_paths,
                        deleted_paths=deleted_paths,
                    )
                )
            return True
        if method == "POST" and path == "/api/fact-groups":
            if set(payload) != {"group"} or not isinstance(
                payload.get("group"), dict
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain only a fact group object",
                )
            else:
                self._store_call(lambda: store.create_fact_group(payload["group"]))
            return True
        if len(parts) == 4 and parts[1:3] == ["api", "fact-groups"] and method == "PATCH":
            if set(payload) != {"patch", "expectedRevision"} or not isinstance(
                payload.get("patch"), dict
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST, "body requires patch and expectedRevision"
                )
                return True
            revision = self._expected_revision(payload)
            if revision is not None:
                self._store_call(
                    lambda: store.update_fact_group(
                        parts[3], payload["patch"], revision
                    )
                )
            return True
        if (
            len(parts) == 5
            and parts[1:3] == ["api", "fact-groups"]
            and parts[4] == "delete"
            and method == "POST"
        ):
            if set(payload) != {"expectedRevision"}:
                self._error(
                    HTTPStatus.BAD_REQUEST, "delete body requires expectedRevision"
                )
                return True
            revision = self._expected_revision(payload)
            if revision is not None:
                self._store_call(lambda: store.delete_fact_group(parts[3], revision))
            return True
        return False
