"""Safe discovery, preview, and commit of legacy job-search reports."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import stat
from pathlib import Path
from typing import Any

from ...errors import StoreError


_RUNTIME_PROVIDER = lambda: globals()
_DRIFT_MESSAGE = (
    "legacy job preview token rejected because the source, selection, input, or store drifted"
)


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


def _invalid_item(item_id: str, reason: str, source: dict[str, Any]) -> dict[str, Any]:
    return {"itemId": item_id, "state": "invalid", "reason": reason, "source": source}


def _locator_identity(source: dict[str, Any]) -> tuple[str, str, str]:
    return source["sourceKind"], source["relativePath"], source["entryId"]


class JobLegacyMixin:
    """Legacy job migration composed ahead of the compatibility Store."""

    @staticmethod
    def _read_legacy_search_file(
        root_descriptor: int | None,
        root: Path,
        name: str,
        metadata: os.stat_result,
    ) -> bytes:
        runtime = _runtime()
        os_module = runtime.get("os", os)
        stat_module = runtime.get("stat", stat)
        limit = runtime["LEGACY_SEARCH_MAX_FILE_BYTES"]
        flags = os_module.O_RDONLY | getattr(os_module, "O_NOFOLLOW", 0)
        try:
            descriptor = (
                os_module.open(root / name, flags)
                if root_descriptor is None
                else os_module.open(name, flags, dir_fd=root_descriptor)
            )
        except OSError as error:
            raise StoreError("legacy search report cannot be opened safely") from error
        try:
            opened = os_module.fstat(descriptor)
            if (
                not stat_module.S_ISREG(opened.st_mode)
                or opened.st_dev != metadata.st_dev
                or opened.st_ino != metadata.st_ino
                or opened.st_size != metadata.st_size
            ):
                raise StoreError("legacy search report changed during discovery")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os_module.read(descriptor, min(65536, limit + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > limit:
                    raise StoreError(
                        "legacy search report exceeds the per-file byte limit"
                    )
            closed = os_module.fstat(descriptor)
            if closed.st_size != opened.st_size:
                raise StoreError("legacy search report changed during discovery")
            return b"".join(chunks)
        finally:
            os_module.close(descriptor)

    @staticmethod
    def _parse_legacy_search_report(
        relative_path: str, source_sha256: str, text: str
    ) -> list[dict[str, Any]]:
        runtime = _runtime()
        re_module = runtime.get("re", re)
        hash_module = runtime.get("hashlib", hashlib)
        lines = text.splitlines()
        starts = [
            index for index, line in enumerate(lines) if line.startswith("###")
        ]
        items: list[dict[str, Any]] = []
        heading_identities = [
            re_module.sub(r"^###\s+\d+\.\s*", "", lines[start]).strip()
            for start in starts
        ]
        heading_totals = {
            identity: heading_identities.count(identity)
            for identity in set(heading_identities)
        }
        content_occurrences: dict[str, int] = {}
        for ordinal, start in enumerate(starts, 1):
            end = starts[ordinal] if ordinal < len(starts) else len(lines)
            heading = lines[start]
            heading_identity = heading_identities[ordinal - 1]
            content_identity = heading_identity
            if heading_totals[heading_identity] > 1:
                content_identity = "\n".join(
                    [heading_identity, *lines[start + 1 : end]]
                ).strip()
            content_occurrence = content_occurrences.get(content_identity, 0) + 1
            content_occurrences[content_identity] = content_occurrence
            entry_id = "legacy-entry-" + hash_module.sha256(
                f"{relative_path}\0{content_identity}\0{content_occurrence}".encode(
                    "utf-8"
                )
            ).hexdigest()[:24]
            item_id = "legacy-item-" + hash_module.sha256(
                entry_id.encode("utf-8")
            ).hexdigest()[:24]
            locator = {
                "sourceKind": "timestamped-search-report",
                "relativePath": relative_path,
                "entryId": entry_id,
                "sourceSha256": source_sha256,
            }

            heading_match = re_module.fullmatch(
                r"###\s+\d+\.\s+(.+?)\s+—\s+(.+)", heading
            )
            if heading_match is None:
                items.append(_invalid_item(item_id, "unsupported_heading", locator))
                continue
            role = heading_match.group(1).strip()
            company = re_module.sub(
                r"\s+\(Score:\s*[^)]*\)\s*$", "", heading_match.group(2)
            ).strip()
            if not role or not company:
                items.append(_invalid_item(item_id, "incomplete_heading", locator))
                continue

            labels: dict[str, str] = {}
            duplicate = False
            for line in lines[start + 1 : end]:
                field = re_module.fullmatch(r"- \*\*([^*]+)\*\*:\s*(.*)", line)
                if field is None:
                    continue
                label = field.group(1).strip().lower()
                if label in labels:
                    duplicate = True
                    break
                labels[label] = field.group(2).strip()
            if duplicate:
                items.append(_invalid_item(item_id, "duplicate_field", locator))
                continue

            url_candidates = []
            for label in ("url", "apply"):
                value = labels.get(label, "")
                if re_module.fullmatch(r"https?://\S+", value):
                    try:
                        normalized = runtime["normalize_job_url"](value)
                    except StoreError:
                        continue
                    url_candidates.append((value, normalized))
            unique_urls = {normalized for _value, normalized in url_candidates}
            if not url_candidates:
                items.append(_invalid_item(item_id, "missing_url", locator))
                continue
            if len(unique_urls) != 1:
                items.append(_invalid_item(item_id, "ambiguous_url", locator))
                continue

            job: dict[str, Any] = {
                "url": url_candidates[0][0],
                "role": role,
                "company": company,
            }
            mappings = {"source": "source", "location": "location",
                        "salary": "compensation", "description": "description"}
            for label, canonical in mappings.items():
                if labels.get(label):
                    job[canonical] = labels[label]
            items.append({"itemId": item_id, "state": "valid",
                          "source": locator, "job": job})
        return items

    def _discover_legacy_jobs(self) -> dict[str, Any]:
        runtime = _runtime()
        os_module = runtime.get("os", os)
        stat_module = runtime.get("stat", stat)
        root_name = runtime["LEGACY_SEARCH_ROOT"]
        root = runtime.get("Path", Path).home() / root_name
        try:
            root_metadata = root.lstat()
        except FileNotFoundError:
            return {"root": f"~/{root_name}", "manifest": [], "items": []}
        except OSError as error:
            raise StoreError("legacy search root cannot be inspected") from error
        if not stat_module.S_ISDIR(root_metadata.st_mode) or stat_module.S_ISLNK(
            root_metadata.st_mode
        ):
            raise StoreError("legacy search root must be a regular directory")

        root_descriptor: int | None = None
        if os_module.name != "nt":
            root_flags = (
                os_module.O_RDONLY
                | getattr(os_module, "O_DIRECTORY", 0)
                | getattr(os_module, "O_NOFOLLOW", 0)
            )
            try:
                root_descriptor = os_module.open(root, root_flags)
            except OSError as error:
                raise StoreError("legacy search root cannot be opened safely") from error
        manifest: list[dict[str, Any]] = []
        items: list[dict[str, Any]] = []
        aggregate = 0
        try:
            opened_root = (
                root.lstat()
                if root_descriptor is None
                else os_module.fstat(root_descriptor)
            )
            if (
                not stat_module.S_ISDIR(opened_root.st_mode)
                or opened_root.st_dev != root_metadata.st_dev
                or opened_root.st_ino != root_metadata.st_ino
            ):
                raise StoreError("legacy search root changed during discovery")
            paths = sorted(
                name
                for name in os_module.listdir(
                    root if root_descriptor is None else root_descriptor
                )
                if name.startswith("search-") and name.endswith(".md")
            )
            if len(paths) > runtime["LEGACY_SEARCH_MAX_FILES"]:
                raise StoreError("legacy search discovery exceeds the file limit")
            for name in paths:
                try:
                    metadata = (
                        (root / name).lstat()
                        if root_descriptor is None
                        else os_module.stat(
                            name, dir_fd=root_descriptor, follow_symlinks=False
                        )
                    )
                except OSError as error:
                    raise StoreError(
                        "legacy search report cannot be inspected"
                    ) from error
                if not stat_module.S_ISREG(
                    metadata.st_mode
                ) or stat_module.S_ISLNK(metadata.st_mode):
                    raise StoreError("legacy search reports must be regular files")
                if metadata.st_size > runtime["LEGACY_SEARCH_MAX_FILE_BYTES"]:
                    raise StoreError(
                        "legacy search report exceeds the per-file byte limit"
                    )
                aggregate += metadata.st_size
                if aggregate > runtime["LEGACY_SEARCH_MAX_TOTAL_BYTES"]:
                    raise StoreError(
                        "legacy search discovery exceeds the aggregate byte limit"
                    )
                raw = self._read_legacy_search_file(
                    root_descriptor, root, name, metadata
                )
                try:
                    decoded = raw.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise StoreError(
                        "legacy search report is not valid UTF-8"
                    ) from error
                digest = runtime.get("hashlib", hashlib).sha256(raw).hexdigest()
                manifest.append({"relativePath": name, "sourceSha256": digest,
                                 "size": len(raw)})
                items.extend(self._parse_legacy_search_report(name, digest, decoded))
                if len(items) > runtime["LEGACY_SEARCH_MAX_ENTRIES"]:
                    raise StoreError(
                        "legacy search discovery exceeds the entry limit"
                    )
        finally:
            if root_descriptor is not None:
                os_module.close(root_descriptor)
        if root_descriptor is None:
            try:
                closed_root = root.lstat()
            except OSError as error:
                raise StoreError("legacy search root changed during discovery") from error
            if (
                not stat_module.S_ISDIR(closed_root.st_mode)
                or closed_root.st_dev != root_metadata.st_dev
                or closed_root.st_ino != root_metadata.st_ino
            ):
                raise StoreError("legacy search root changed during discovery")
        return {"root": f"~/{root_name}", "manifest": manifest, "items": items}

    def _migration_jobs_snapshot(self) -> tuple[dict[str, Any], Any]:
        if self.jobs_path.exists():
            document = self._load_jobs_document()
            return document, document
        document = {
            "schemaVersion": _runtime()["SCHEMA_VERSION"],
            "jobs": {},
            "metadata": {"createdAt": "1970-01-01T00:00:00Z",
                         "updatedAt": "1970-01-01T00:00:00Z"},
        }
        return document, {"state": "missing"}

    @staticmethod
    def _selected_legacy_items(
        discovery: dict[str, Any],
        selected: list[str],
        *,
        unknown_message: str = "legacy job selection contains an unknown item id",
        invalid_message: str = "legacy job selection contains an invalid item",
    ) -> list[dict[str, Any]]:
        if len(selected) != len(set(selected)):
            raise StoreError("legacy job selection contains duplicate item ids")
        indexed = {item["itemId"]: item for item in discovery["items"]}
        chosen: list[dict[str, Any]] = []
        for item_id in selected:
            item = indexed.get(item_id)
            if item is None:
                raise StoreError(unknown_message)
            if item["state"] != "valid":
                raise StoreError(invalid_message)
            chosen.append(item)
        return chosen

    @staticmethod
    def _legacy_jobs_token(
        discovery: dict[str, Any],
        selected: list[str],
        chosen: list[dict[str, Any]],
        snapshot: Any,
    ) -> str:
        bound = {
            "version": 1,
            "origin": "migration",
            "selection": selected,
            "payloads": [item["job"] for item in chosen],
            "selectedLocators": [item["source"] for item in chosen],
            "manifest": discovery["manifest"],
            "jobsSnapshot": snapshot,
        }
        runtime = _runtime()
        return "legacy-jobs-v1." + runtime.get("hashlib", hashlib).sha256(
            runtime["_canonical_json"](bound).encode("utf-8")
        ).hexdigest()

    def _plan_legacy_jobs(
        self, document: dict[str, Any], chosen: list[dict[str, Any]], now: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
        payload = {"jobs": [item["job"] for item in chosen]}
        target_ids: list[str | None] = []
        for item in chosen:
            locator = item["source"]
            identity = _locator_identity(locator)
            matches = [
                record["id"]
                for record in document["jobs"].values()
                if any(
                    _locator_identity(source) == identity
                    for source in record.get("legacySources", [])
                )
            ]
            if len(matches) > 1:
                raise StoreError("legacy source locator resolves to multiple jobs")
            target_ids.append(matches[0] if matches else None)
        planned, decisions, changed = self._plan_job_upsert(
            document,
            payload,
            "migration",
            now,
            _allow_migration=True,
            _target_ids=target_ids,
        )
        for item, decision in zip(chosen, decisions):
            decision["itemId"] = item["itemId"]
            if decision["action"] in {"conflict", "invalid"}:
                continue
            record = planned["jobs"][decision["id"]]
            sources = list(record.get("legacySources", []))
            locator = item["source"]
            identity = _locator_identity(locator)
            replaced = False
            merged = []
            for source in sources:
                if _locator_identity(source) == identity:
                    merged.append(locator)
                    replaced = True
                else:
                    merged.append(source)
            if not replaced:
                merged.append(locator)
            merged.sort(key=lambda source: (source["relativePath"], source["entryId"]))
            if merged != sources:
                record["legacySources"] = merged
                if decision["action"] == "noop":
                    record["revision"] += 1
                    record["updatedAt"] = now
                    decision["action"] = "update"
                    decision["fields"] = ["legacySources"]
                elif decision["action"] == "update":
                    decision["fields"] = sorted(
                        set(decision.get("fields", [])) | {"legacySources"}
                    )
                changed = True
                planned["metadata"]["updatedAt"] = now
                _runtime()["_validate_job_record"](record["id"], record)
        if (
            document["metadata"].get("createdAt") == "1970-01-01T00:00:00Z"
            and changed
        ):
            planned["metadata"]["createdAt"] = now
        return planned, decisions, changed

    @staticmethod
    def _legacy_result(
        discovery: dict[str, Any],
        selected: list[str],
        decisions: list[dict[str, Any]] | None = None,
        token: str | None = None,
        committed: bool = False,
    ) -> dict[str, Any]:
        result = {"root": discovery["root"], "manifest": discovery["manifest"],
                  "items": discovery["items"], "selected": selected,
                  "committed": committed}
        if decisions is not None:
            counts = {
                action: 0
                for action in ("create", "update", "noop", "conflict", "invalid")
            }
            for decision in decisions:
                counts[decision["action"]] += 1
            result.update(
                {"token": token, "summary": counts, "decisions": decisions}
            )
        return result

    def preview_legacy_jobs(self, selected: list[str]) -> dict[str, Any]:
        discovery = self._discover_legacy_jobs()
        if not selected:
            return self._legacy_result(discovery, [])
        chosen = self._selected_legacy_items(discovery, selected)
        document, snapshot = self._migration_jobs_snapshot()
        token = self._legacy_jobs_token(discovery, selected, chosen, snapshot)
        _planned, decisions, _changed = self._plan_legacy_jobs(
            document, chosen, _runtime()["utc_now"]()
        )
        return self._legacy_result(discovery, selected, decisions, token)

    def commit_legacy_jobs(
        self, selected: list[str], token: str
    ) -> dict[str, Any]:
        if not selected or not isinstance(token, str) or not token:
            raise StoreError(
                "legacy job commit requires selection and a preview token"
            )
        runtime = _runtime()
        with runtime["exclusive_file_lock"](self.store_lock_path):
            discovery = self._discover_legacy_jobs()
            chosen = self._selected_legacy_items(
                discovery,
                selected,
                unknown_message=_DRIFT_MESSAGE,
                invalid_message=_DRIFT_MESSAGE,
            )
            document, snapshot = self._migration_jobs_snapshot()
            expected = self._legacy_jobs_token(
                discovery, selected, chosen, snapshot
            )
            if not runtime.get("hmac", hmac).compare_digest(token, expected):
                raise StoreError(_DRIFT_MESSAGE)
            planned, decisions, changed = self._plan_legacy_jobs(
                document, chosen, runtime["utc_now"]()
            )
            if changed:
                runtime["atomic_write_json"](self.jobs_path, planned)
        return self._legacy_result(discovery, selected, decisions, token, changed)
