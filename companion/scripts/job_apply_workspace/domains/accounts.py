"""Automation, employer-account, and trusted-fill mutation routes."""

from __future__ import annotations

from http import HTTPStatus
from typing import Any


class AccountMutationMixin:
    def _mutate_accounts(
        self, method: str, path: str, parts: list[str], payload: dict[str, Any]
    ) -> bool:
        store = self.server.store
        if method == "POST" and path == "/api/automation/realm-resolve":
            if set(payload) != {"url"} or not isinstance(payload.get("url"), str):
                self._error(
                    HTTPStatus.BAD_REQUEST, "body must contain only a portal URL"
                )
            else:
                self._store_call(lambda: store.resolve_account_realm(payload["url"]))
            return True
        if method == "POST" and path == "/api/trusted-fill/approve":
            self._store_call(lambda: store.approve_trusted_fill(payload, public=True))
            return True
        if method == "POST" and path == "/api/account-operation/execute-synthetic":
            self._store_call(
                lambda: store.execute_synthetic_account(payload, public=True)
            )
            return True
        if method == "POST" and path == "/api/account-operation/recover":
            if payload != {}:
                self._error(
                    HTTPStatus.BAD_REQUEST, "account recovery body must be empty"
                )
            else:
                self._store_call(store.recover_account_operation)
            return True
        if method == "POST" and path == "/api/trusted-fill/evaluate":
            self._store_call(lambda: store.evaluate_trusted_fill(payload, public=True))
            return True
        if (
            method == "POST"
            and len(parts) == 5
            and parts[1:3] == ["api", "trusted-fill"]
            and parts[4] == "revoke"
        ):
            if set(payload) != {"expectedApprovalRevision"}:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain only expectedApprovalRevision",
                )
                return True
            revision = payload.get("expectedApprovalRevision")
            if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "expectedApprovalRevision must be a positive integer",
                )
            else:
                self._store_call(
                    lambda: store.revoke_trusted_fill(
                        parts[3], revision, public=True
                    )
                )
            return True
        if method == "PATCH" and path == "/api/automation/settings":
            if set(payload) != {"patch", "expectedRevision"} or not isinstance(
                payload.get("patch"), dict
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain a settings patch and expectedRevision",
                )
                return True
            revision = self._expected_revision(payload)
            if revision is not None:
                self._store_call(
                    lambda: store.update_automation_settings(
                        payload["patch"], revision, public=True
                    )
                )
            return True
        if method == "POST" and path == "/api/automation/settings/copy-profile-email":
            if set(payload) != {
                "expectedProfileRevision", "expectedSettingsRevision"
            }:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain exact profile and settings revisions",
                )
                return True
            profile_revision = payload.get("expectedProfileRevision")
            settings_revision = payload.get("expectedSettingsRevision")
            if any(
                not isinstance(value, int) or isinstance(value, bool) or value < 1
                for value in (profile_revision, settings_revision)
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "profile and settings revisions must be positive integers",
                )
            else:
                self._store_call(
                    lambda: store.copy_profile_email_to_automation_settings(
                        profile_revision, settings_revision, public=True
                    )
                )
            return True
        if method == "POST" and path == "/api/employer-accounts":
            if (
                set(payload) - {"url", "signupEmailOverride"}
                or "url" not in payload
                or not isinstance(payload["url"], str)
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain a portal URL and optional signup email override",
                )
            else:
                self._store_call(
                    lambda: store.create_employer_account(
                        payload["url"],
                        payload.get("signupEmailOverride"),
                        public=True,
                    )
                )
            return True
        if (
            method == "PATCH"
            and len(parts) == 4
            and parts[1:3] == ["api", "employer-accounts"]
        ):
            if set(payload) != {"patch", "expectedRevision"} or not isinstance(
                payload.get("patch"), dict
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain an account patch and expectedRevision",
                )
                return True
            revision = self._expected_revision(payload)
            if revision is not None:
                self._store_call(
                    lambda: store.update_employer_account(
                        parts[3], payload["patch"], revision, public=True
                    )
                )
            return True
        return False
