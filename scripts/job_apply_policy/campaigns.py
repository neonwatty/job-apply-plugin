"""Campaign lifecycle policy operations."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from .model import (
    CAMPAIGN_FIELDS, CAMPAIGN_STATUSES, MAX_APPLICATIONS, MAX_DURATION,
    SCHEMA_VERSION, PolicyError, _closed, _fingerprint, _new_reference,
    _reference, _rule, _sensitive, format_time, parse_time, utc_now,
)
from .storage import _private_dir, _read_json

class CampaignMixin:
    def _validate_campaign(self, campaign: dict[str, Any]) -> dict[str, Any]:
        _closed(campaign, CAMPAIGN_FIELDS, "campaign")
        if campaign["schemaVersion"] != SCHEMA_VERSION:
            raise PolicyError("campaign schema version is unsupported")
        _reference(campaign["campaignId"], "campaign", "campaignId")
        if campaign["mode"] != "auto_submit":
            raise PolicyError("campaign mode is invalid")
        if campaign["status"] not in CAMPAIGN_STATUSES:
            raise PolicyError("campaign status is invalid")
        created = parse_time(campaign["createdAt"])
        expires = parse_time(campaign["expiresAt"])
        if expires <= created or expires - created > MAX_DURATION:
            raise PolicyError("campaign duration is invalid")
        maximum = campaign["maxApplications"]
        if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= MAX_APPLICATIONS:
            raise PolicyError("campaign application limit is invalid")
        rules = campaign["applicationRules"]
        if not isinstance(rules, list) or not rules:
            raise PolicyError("campaign requires application rules")
        normalized_rules = [_rule(rule) for rule in rules]
        refs = [rule["applicationRef"] for rule in normalized_rules]
        if len(refs) != len(set(refs)):
            raise PolicyError("campaign application rules contain duplicates")
        _fingerprint(campaign["resumeRevision"], "resumeRevision")
        _fingerprint(
            campaign["confirmationAuthorityRevision"],
            "confirmationAuthorityRevision",
        )
        allowlist = campaign["sensitiveAllowlist"]
        if not isinstance(allowlist, list):
            raise PolicyError("sensitiveAllowlist must be a list")
        normalized_allowlist = [_sensitive(item) for item in allowlist]
        answer_refs = [item["answerRef"] for item in normalized_allowlist]
        if len(answer_refs) != len(set(answer_refs)):
            raise PolicyError("sensitiveAllowlist contains duplicates")
        parse_time(campaign["riskAcknowledgedAt"])
        if not isinstance(campaign["killSwitch"], bool):
            raise PolicyError("campaign kill switch is invalid")
        if campaign["killSwitchAt"] is not None:
            parse_time(campaign["killSwitchAt"])
        if campaign["killSwitch"] != (campaign["status"] == "killed"):
            raise PolicyError("campaign kill switch state is inconsistent")
        if campaign["killSwitch"] != (campaign["killSwitchAt"] is not None):
            raise PolicyError("campaign kill switch timestamp is inconsistent")
        reserved = campaign["reservedApplications"]
        if not isinstance(reserved, int) or isinstance(reserved, bool) or not 0 <= reserved <= maximum:
            raise PolicyError("campaign reservation count is invalid")
        return campaign

    def load_campaign(self) -> dict[str, Any]:
        if not self.campaign_path.exists():
            raise PolicyError("campaign does not exist")
        return self._validate_campaign(_read_json(self.campaign_path, "campaign"))

    def _campaign_mode(self, campaign: dict[str, Any], now: datetime) -> tuple[str, str]:
        if campaign["killSwitch"]:
            return "review_only", "kill_switch"
        if campaign["status"] != "active":
            return "review_only", campaign["status"]
        if now >= parse_time(campaign["expiresAt"]):
            return "review_only", "expired"
        return "auto_submit", "active_campaign"

    def decision(self, now: datetime | None = None) -> dict[str, Any]:
        checked_at = now or utc_now()
        try:
            campaign = self.load_campaign()
            mode, reason = self._campaign_mode(campaign, checked_at)
            return {
                "mode": mode,
                "reason": reason,
                "campaignId": campaign["campaignId"] if mode == "auto_submit" else None,
            }
        except (PolicyError, OSError):
            return {"mode": "review_only", "reason": "policy_unavailable", "campaignId": None}

    def activate(self, incoming: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
        current_time = now or utc_now()
        allowed = {
            "riskAcknowledged",
            "applicationRules",
            "resumeRevision",
            "sensitiveAllowlist",
            "confirmationAuthorityRevision",
            "maxApplications",
            "durationSeconds",
        }
        if set(incoming) - allowed:
            raise PolicyError("campaign input contains unsupported fields")
        if incoming.get("riskAcknowledged") is not True:
            raise PolicyError("explicit risk acknowledgement is required")
        rules = incoming.get("applicationRules")
        if not isinstance(rules, list) or not rules:
            raise PolicyError("campaign requires application rules")
        normalized_rules = [_rule(rule) for rule in rules]
        maximum = incoming.get("maxApplications", MAX_APPLICATIONS)
        duration_seconds = incoming.get("durationSeconds", int(MAX_DURATION.total_seconds()))
        if not isinstance(duration_seconds, int) or isinstance(duration_seconds, bool) or not 1 <= duration_seconds <= int(MAX_DURATION.total_seconds()):
            raise PolicyError("campaign duration is invalid")
        campaign = {
            "schemaVersion": SCHEMA_VERSION,
            "campaignId": _new_reference("campaign"),
            "mode": "auto_submit",
            "status": "active",
            "createdAt": format_time(current_time),
            "expiresAt": format_time(current_time + timedelta(seconds=duration_seconds)),
            "maxApplications": maximum,
            "applicationRules": normalized_rules,
            "resumeRevision": _fingerprint(incoming.get("resumeRevision"), "resumeRevision"),
            "sensitiveAllowlist": [
                _sensitive(item) for item in incoming.get("sensitiveAllowlist", [])
            ],
            "confirmationAuthorityRevision": _fingerprint(
                incoming.get("confirmationAuthorityRevision"),
                "confirmationAuthorityRevision",
            ),
            "riskAcknowledgedAt": format_time(current_time),
            "killSwitch": False,
            "killSwitchAt": None,
            "reservedApplications": 0,
        }
        self._validate_campaign(campaign)
        with self._lock():
            if self.campaign_path.exists():
                previous = self.load_campaign()
                previous_mode, _ = self._campaign_mode(previous, current_time)
                if previous_mode == "auto_submit" or previous["killSwitch"]:
                    raise PolicyError("an active or killed campaign cannot be replaced")
                _private_dir(self.archive_dir)
                archive_path = self.archive_dir / f"{previous['campaignId'].split(':', 1)[1]}.json"
                if archive_path.exists():
                    archived = self._validate_campaign(
                        _read_json(archive_path, "campaign archive")
                    )
                    if archived != previous:
                        raise PolicyError("campaign archive already exists")
                else:
                    self._write_json(archive_path, previous)
            self._write_json(self.campaign_path, campaign)
        return campaign

    def _load_campaign_by_id(self, campaign_id: str) -> dict[str, Any]:
        _reference(campaign_id, "campaign", "campaignId")
        current = self.load_campaign()
        if current["campaignId"] == campaign_id:
            return current
        archive_path = self.archive_dir / f"{campaign_id.split(':', 1)[1]}.json"
        if not archive_path.exists():
            raise PolicyError("campaign does not exist")
        archived = self._validate_campaign(
            _read_json(archive_path, "campaign archive")
        )
        if archived["campaignId"] != campaign_id:
            raise PolicyError("campaign archive does not match")
        return archived
