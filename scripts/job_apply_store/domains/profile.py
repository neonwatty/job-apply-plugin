"""Profile document behavior for composed Store implementations."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import io, normalization
from ..constants import FACT_SOURCES, SCHEMA_VERSION
from ..errors import StoreError


def _runtime(instance: Any) -> dict[str, Any]:
    return instance._runtime_provider()


def _utc_now(instance: Any) -> str:
    runtime = _runtime(instance)
    provider = runtime.get("utc_now")
    if provider is not None:
        return provider()
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _require_object(instance: Any, value: Any, label: str) -> dict[str, Any]:
    provider = _runtime(instance).get("_require_object")
    return io.require_object(value, label) if provider is None else provider(value, label)


def _read_json_object(instance: Any, path: Any, label: str) -> dict[str, Any]:
    provider = _runtime(instance).get("read_json_object")
    return io.read_json_object(path, label) if provider is None else provider(path, label)


def _validate_version(instance: Any, document: dict[str, Any], label: str) -> None:
    provider = _runtime(instance).get("validate_version")
    if provider is None:
        io.validate_version(document, label)
    else:
        provider(document, label)


def _exclusive_file_lock(instance: Any, path: Any):
    runtime = _runtime(instance)
    provider = runtime.get("exclusive_file_lock")
    if provider is not None:
        return provider(path)
    return io.exclusive_file_lock(path, _runtime=runtime)


def _atomic_write_json(instance: Any, path: Any, payload: dict[str, Any]) -> None:
    runtime = _runtime(instance)
    provider = runtime.get("atomic_write_json")
    if provider is None:
        io.atomic_write_json(path, payload, _runtime=runtime)
    else:
        provider(path, payload)


class ProfileStoreMixin:
    """Profile operations composed ahead of the compatibility Store."""

    @staticmethod
    def _merge_object_patch(
        target: dict[str, Any], patch: dict[str, Any], prefix: str = ""
    ) -> tuple[dict[str, Any], list[str]]:
        """Apply an object merge patch and return changed JSON-pointer paths."""

        updated = dict(target)
        changed: list[str] = []
        for key, value in patch.items():
            if not isinstance(key, str) or not key:
                raise StoreError("profile patch keys must be non-empty strings")
            path = f"{prefix}/{normalization._json_pointer_segment(key)}"
            if value is None:
                if key in updated:
                    del updated[key]
                    changed.append(path)
                continue
            current = updated.get(key)
            if isinstance(value, dict):
                base = current if isinstance(current, dict) else {}
                nested, nested_changed = ProfileStoreMixin._merge_object_patch(
                    base, value, path
                )
                if nested_changed or not isinstance(current, dict):
                    updated[key] = nested
                    changed.extend(nested_changed or [path])
                continue
            if current != value:
                updated[key] = value
                changed.append(path)
        return updated, changed

    @staticmethod
    def _apply_profile_patch(
        target: dict[str, Any],
        patch: dict[str, Any],
        atomic_paths: list[str],
        deleted_paths: list[str],
    ) -> tuple[dict[str, Any], list[str]]:
        """Apply merge-patch fields plus explicit atomic replacements/deletions."""

        atomic_keys = {
            normalization._top_level_pointer_key(path): path for path in atomic_paths
        }
        deleted = set(deleted_paths)
        if len(atomic_keys) != len(atomic_paths) or len(deleted) != len(deleted_paths):
            raise StoreError("atomic profile paths must be unique")
        if not deleted <= set(atomic_paths):
            raise StoreError("deleted profile paths must also be atomic")
        if any(key not in patch for key in atomic_keys):
            raise StoreError("atomic profile paths must be present in the patch")

        merge_patch = {
            key: value for key, value in patch.items() if key not in atomic_keys
        }
        updated, changed = ProfileStoreMixin._merge_object_patch(target, merge_patch)
        for key, path in atomic_keys.items():
            if path in deleted:
                if key in updated:
                    del updated[key]
                    changed.append(path)
            elif key not in updated or updated[key] != patch[key]:
                updated[key] = patch[key]
                changed.append(path)
        return updated, changed

    @staticmethod
    def _changed_json_pointer_paths(
        current: Any, replacement: Any, prefix: str = ""
    ) -> list[str]:
        """Return narrow changed paths, treating non-objects as atomic values."""
        if isinstance(current, dict) and isinstance(replacement, dict):
            changed: list[str] = []
            for key in sorted(set(current) | set(replacement)):
                path = f"{prefix}/{normalization._json_pointer_segment(key)}"
                if key not in current or key not in replacement:
                    changed.append(path)
                else:
                    changed.extend(
                        ProfileStoreMixin._changed_json_pointer_paths(
                            current[key], replacement[key], path
                        )
                    )
            return changed
        return [prefix or "/"] if current != replacement else []

    @staticmethod
    def _protect_user_provenance(
        provenance: dict[str, Any], changed: list[str], source: str
    ) -> None:
        """Reject lower-authority writes overlapping a human-authored fact path."""
        if source == "user":
            return
        protected = [
            path
            for path, record in provenance.items()
            if record.get("source") == "user"
        ]
        if any(
            changed_path == protected_path
            or changed_path.startswith(f"{protected_path}/")
            or protected_path.startswith(f"{changed_path}/")
            for changed_path in changed
            for protected_path in protected
        ):
            raise StoreError("profile change conflicts with user-provenanced facts")

    @staticmethod
    def _user_protects_path(provenance: dict[str, Any], path: str) -> bool:
        return any(
            record.get("source") == "user"
            and (
                path == protected
                or path.startswith(f"{protected}/")
                or protected.startswith(f"{path}/")
            )
            for protected, record in provenance.items()
        )

    @staticmethod
    def _fact_leaf_paths(value: Any, prefix: str) -> list[str]:
        if isinstance(value, dict) and value:
            return [
                leaf
                for key, child in value.items()
                for leaf in ProfileStoreMixin._fact_leaf_paths(
                    child, f"{prefix}/{normalization._json_pointer_segment(key)}"
                )
            ]
        return [prefix]

    @staticmethod
    def _stamp_fact_provenance(
        provenance: dict[str, Any],
        changed: list[str],
        source: str,
        updated_at: str,
        current_profile: dict[str, Any],
    ) -> dict[str, Any]:
        stamped = dict(provenance)
        # Refining a parent marker to a changed child must not discard the
        # authority of unchanged siblings. Materialize the parent's existing
        # leaf provenance before replacing the changed branch marker.
        for protected_path, record in list(provenance.items()):
            if any(path.startswith(f"{protected_path}/") for path in changed):
                for leaf in ProfileStoreMixin._fact_leaf_paths(
                    normalization._json_pointer_value(
                        current_profile, protected_path
                    ),
                    protected_path,
                ):
                    stamped.setdefault(leaf, record)
        for path in changed:
            prefix = f"{path}/"
            for stale in [
                key
                for key in stamped
                if key.startswith(prefix) or path.startswith(f"{key}/")
            ]:
                stamped.pop(stale, None)
            stamped[path] = {"source": source, "updatedAt": updated_at}
        return stamped

    @staticmethod
    def _has_application_facts(profile: dict[str, Any]) -> bool:
        """Distinguish applicant facts from search-only preferences."""

        return any(key != "preferences" for key in profile)

    def _load_profile_document(self) -> dict[str, Any]:
        document = _read_json_object(self, self.profile_path, "profile")
        _validate_version(self, document, "profile")
        _require_object(self, document.get("profile"), "profile.profile")
        metadata = _require_object(self, document.get("metadata"), "profile.metadata")
        revision = metadata.get("revision", 1)
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise StoreError("profile revision must be a positive integer")
        provenance = _require_object(
            self, metadata.get("factProvenance", {}), "profile fact provenance"
        )
        for path, value in provenance.items():
            if not isinstance(path, str) or not path.startswith("/"):
                raise StoreError("profile fact provenance path is invalid")
            record = _require_object(self, value, "profile fact provenance record")
            if set(record) != {"source", "updatedAt"}:
                raise StoreError("profile fact provenance record is invalid")
            if record.get("source") not in FACT_SOURCES:
                raise StoreError("profile fact provenance source is unsupported")
            if not isinstance(record.get("updatedAt"), str) or not record["updatedAt"]:
                raise StoreError("profile fact provenance timestamp is invalid")
        return document

    @staticmethod
    def _validate_profile_document_value(document: dict[str, Any]) -> None:
        io.validate_version(document, "profile")
        profile = io.require_object(document.get("profile"), "profile.profile")
        metadata = io.require_object(document.get("metadata"), "profile.metadata")
        if set(document) != {"schemaVersion", "profile", "metadata"}:
            raise StoreError("profile contains unsupported fields")
        revision = metadata.get("revision", 1)
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise StoreError("profile revision must be a positive integer")
        provenance = io.require_object(
            metadata.get("factProvenance", {}), "profile fact provenance"
        )
        for path, value in provenance.items():
            if not isinstance(path, str) or not path.startswith("/"):
                raise StoreError("profile fact provenance path is invalid")
            record = io.require_object(value, "profile fact provenance record")
            if set(record) != {"source", "updatedAt"}:
                raise StoreError("profile fact provenance record is invalid")
            if record.get("source") not in FACT_SOURCES:
                raise StoreError("profile fact provenance source is unsupported")
            if not isinstance(record.get("updatedAt"), str) or not record["updatedAt"]:
                raise StoreError("profile fact provenance timestamp is invalid")
        _ = profile

    def get_profile(self) -> dict[str, Any]:
        self.initialize()
        return self._load_profile_document()["profile"]

    def inspect_profile(self) -> dict[str, Any]:
        self.initialize()
        return self._profile_inspection(self._load_profile_document())

    @staticmethod
    def _profile_inspection(document: dict[str, Any]) -> dict[str, Any]:
        metadata = document["metadata"]
        return {
            "profile": document["profile"],
            "revision": metadata.get("revision", 1),
            "factProvenance": metadata.get("factProvenance", {}),
            "updatedAt": metadata.get("updatedAt"),
        }

    def replace_profile(
        self, profile: dict[str, Any], expected_revision: int, source: str
    ) -> dict[str, Any]:
        incoming = _require_object(self, profile, "profile")
        if (
            not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 0
        ):
            raise StoreError("profile expected revision must be a non-negative integer")
        if source not in FACT_SOURCES:
            raise StoreError("profile fact source is unsupported")
        if self.profile_path.exists():
            self.initialize()
        result: dict[str, Any] | None = None
        conflict_after_migration = False
        with _exclusive_file_lock(self, self.store_lock_path):
            if not self.profile_path.exists():
                self._validate_existing_documents()
                now = _utc_now(self)
                if self.legacy_profile.exists():
                    migrated = _read_json_object(self, self.legacy_profile, "legacy profile")
                    _atomic_write_json(
                        self,
                        self.profile_path,
                        {
                            "schemaVersion": SCHEMA_VERSION,
                            "profile": migrated,
                            "metadata": {
                                "createdAt": now,
                                "updatedAt": now,
                                "revision": 1,
                                "factProvenance": {},
                                "migratedFrom": "~/.claude-job-profile.json",
                                "migratedAt": now,
                            },
                        },
                    )
                    conflict_after_migration = True
                elif expected_revision == 0:
                    changed = self._changed_json_pointer_paths({}, incoming)
                    document = {
                        "schemaVersion": SCHEMA_VERSION,
                        "profile": incoming,
                        "metadata": {
                            "createdAt": now,
                            "updatedAt": now,
                            "revision": 1,
                            "factProvenance": self._stamp_fact_provenance(
                                {}, changed, source, now, {}
                            ),
                        },
                    }
                    _atomic_write_json(self, self.profile_path, document)
                    result = self._profile_inspection(document)
                else:
                    raise StoreError("profile revision conflict")

            if result is None and not conflict_after_migration:
                document = self._load_profile_document()
                metadata = document["metadata"]
                revision = metadata.get("revision", 1)
                if expected_revision == 0 or revision != expected_revision:
                    raise StoreError("profile revision conflict")
                changed = self._changed_json_pointer_paths(document["profile"], incoming)
                if not changed:
                    result = self._profile_inspection(document)
                else:
                    provenance = dict(metadata.get("factProvenance", {}))
                    self._protect_user_provenance(provenance, changed, source)
                    now = _utc_now(self)
                    stamped_provenance = self._stamp_fact_provenance(
                        provenance, changed, source, now, document["profile"]
                    )
                    document["profile"] = incoming
                    metadata["updatedAt"] = now
                    metadata["revision"] = revision + 1
                    metadata["factProvenance"] = stamped_provenance
                    _atomic_write_json(self, self.profile_path, document)
                    result = self._profile_inspection(document)
        self.initialize()
        if conflict_after_migration:
            raise StoreError("profile revision conflict")
        assert result is not None
        return result

    def patch_profile(
        self,
        patch: dict[str, Any],
        expected_revision: int,
        source: str,
        atomic_paths: list[str] | None = None,
        deleted_paths: list[str] | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        incoming = _require_object(self, patch, "profile patch")
        if not incoming:
            raise StoreError("profile patch must not be empty")
        if source not in FACT_SOURCES:
            raise StoreError("profile fact source is unsupported")
        atomic = atomic_paths or []
        deleted = deleted_paths or []
        if not isinstance(atomic, list) or not all(
            isinstance(path, str) for path in atomic
        ):
            raise StoreError("atomic profile paths must be strings")
        if not isinstance(deleted, list) or not all(
            isinstance(path, str) for path in deleted
        ):
            raise StoreError("deleted profile paths must be strings")
        with _exclusive_file_lock(self, self.store_lock_path):
            document = self._load_profile_document()
            metadata = document["metadata"]
            revision = metadata.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("profile revision conflict")
            updated, changed = self._apply_profile_patch(
                document["profile"], incoming, atomic, deleted
            )
            if not changed:
                return self._profile_inspection(document)
            now = _utc_now(self)
            provenance = dict(metadata.get("factProvenance", {}))
            self._protect_user_provenance(provenance, changed, source)
            provenance = self._stamp_fact_provenance(
                provenance, changed, source, now, document["profile"]
            )
            document["profile"] = updated
            metadata["factProvenance"] = provenance
            metadata["revision"] = revision + 1
            metadata["updatedAt"] = now
            _atomic_write_json(self, self.profile_path, document)
        return {
            "profile": updated,
            "revision": revision + 1,
            "factProvenance": provenance,
            "updatedAt": now,
        }

    def get_preferences(self) -> dict[str, Any]:
        preferences = self.get_profile().get("preferences", {})
        return _require_object(self, preferences, "profile.preferences")

    def set_preferences(
        self,
        preferences: dict[str, Any],
        expected_revision: int,
        source: str,
        replace: bool = False,
    ) -> dict[str, Any]:
        incoming = _require_object(self, preferences, "preferences")
        if not replace:
            return self.patch_profile(
                {"preferences": incoming}, expected_revision, source
            )

        if source not in FACT_SOURCES:
            raise StoreError("profile fact source is unsupported")
        self.initialize()
        with _exclusive_file_lock(self, self.store_lock_path):
            document = self._load_profile_document()
            metadata = document["metadata"]
            revision = metadata.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("profile revision conflict")
            updated = dict(document["profile"])
            updated["preferences"] = incoming
            changed = self._changed_json_pointer_paths(document["profile"], updated)
            if not changed:
                return self._profile_inspection(document)
            now = _utc_now(self)
            provenance = dict(metadata.get("factProvenance", {}))
            self._protect_user_provenance(provenance, changed, source)
            provenance = self._stamp_fact_provenance(
                provenance, changed, source, now, document["profile"]
            )
            document["profile"] = updated
            metadata["factProvenance"] = provenance
            metadata["revision"] = revision + 1
            metadata["updatedAt"] = now
            _atomic_write_json(self, self.profile_path, document)
        return self._profile_inspection(document)
