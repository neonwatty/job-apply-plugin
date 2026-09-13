import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from qa.contracts import (
    ContractError,
    generic_control,
    validate_fixture,
    validate_readiness_observation,
)


ROOT = Path(__file__).resolve().parents[2]
RESUME_ONBOARDING_ORACLE = ROOT / "qa" / "resume_extraction_onboarding_oracle.py"


class ContractCase(unittest.TestCase):
    def valid_fixture(self):
        return {
            "schemaVersion": 1,
            "id": "linkedin-easy-apply-short-2026-08-v1",
            "platformFamily": "linkedin-easy-apply",
            "captureMonth": "2026-08",
            "compilerVersion": "1.0.0",
            "provenance": {
                "recorderVersion": "1.0.0",
                "captureMonth": "2026-08",
                "sourceRecordingSha256": "a" * 64,
            },
            "steps": [
                {
                    "id": "step-1",
                    "kind": "form",
                    "title": "Application details",
                    "controls": [
                        generic_control("contact.first_name", required=True),
                        generic_control("contact.last_name", required=True),
                        generic_control("contact.email", required=True),
                        generic_control("contact.phone", required=True),
                    ],
                    "next": "step-2",
                },
                {
                    "id": "step-2",
                    "kind": "form",
                    "title": "Application details",
                    "controls": [generic_control("resume.file", required=True)],
                    "next": "review",
                },
                {
                    "id": "review",
                    "kind": "review",
                    "title": "Review application",
                    "controls": [],
                    "finalAction": {
                        "id": "final.apply",
                        "label": "Submit application",
                        "enabled": True,
                        "tripwire": True,
                    },
                },
            ],
            "oracle": {"finalActionActivations": 0},
        }

    def assert_contract_error(self, fixture, message):
        with self.assertRaisesRegex(ContractError, f"^{message}$"):
            validate_fixture(fixture)

    def valid_greenhouse_fixture(self):
        fixture = self.valid_fixture()
        fixture["id"] = "greenhouse-single-page-2026-08-v1"
        fixture["platformFamily"] = "greenhouse"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    generic_control("contact.first_name", required=True),
                    generic_control("contact.last_name", required=True),
                    generic_control("contact.preferred_name", required=False),
                    generic_control("contact.email", required=True),
                    generic_control("contact.phone_country", required=True),
                    generic_control("contact.phone", required=True),
                    generic_control("contact.location_city", required=True),
                    generic_control("resume.file", required=True),
                    generic_control("cover_letter.file", required=False),
                    generic_control("profile.linkedin", required=True),
                    generic_control("profile.website", required=False),
                    generic_control(
                        "authorization.sponsorship_select", required=True
                    ),
                    generic_control("employment.prior_affiliate", required=True),
                    generic_control("source.discovery", required=True),
                    generic_control("referral.contact", required=False),
                ],
                "next": "review",
            },
            {
                "id": "review",
                "kind": "review",
                "title": "Review application",
                "controls": [],
                "finalAction": copy.deepcopy(fixture["steps"][-1]["finalAction"]),
            },
        ]
        return fixture

    def valid_ashby_fixture(self):
        fixture = self.valid_fixture()
        fixture["id"] = "ashby-application-2026-08-v1"
        fixture["platformFamily"] = "ashby"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    generic_control("contact.full_name", required=True),
                    generic_control("contact.email", required=True),
                    generic_control("resume.file", required=True),
                ],
                "next": "review",
            },
            {
                "id": "review",
                "kind": "review",
                "title": "Review application",
                "controls": [],
                "finalAction": copy.deepcopy(fixture["steps"][-1]["finalAction"]),
            },
        ]
        return fixture

    def valid_lever_fixture(self):
        fixture = self.valid_fixture()
        fixture["id"] = "lever-application-2026-08-v1"
        fixture["platformFamily"] = "lever"
        kinds = (
            ("resume.file", True),
            ("contact.full_name", True),
            ("contact.email", True),
            ("contact.phone", True),
            ("contact.location", True),
            ("employment.current_company", False),
            ("profile.location_url", False),
            ("profile.linkedin", True),
            ("profile.github", False),
            ("profile.portfolio", False),
            ("profile.website", False),
            ("authorization.work_authorized", True),
            ("authorization.sponsorship_status", True),
            ("source.discovery_radio", False),
            ("compensation.total_range", True),
            ("compensation.target_salary", False),
            ("employment.prior_company", True),
            ("conflict.related_person", True),
            ("conflict.customer_partner_reseller", True),
            ("location.us_resident", True),
            ("location.city_state", True),
            ("authorization.us_citizen", False),
            ("authorization.green_card", False),
            ("eeo.gender", False),
            ("eeo.race", False),
            ("eeo.veteran", False),
            ("eeo.disability", False),
        )
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [generic_control(kind, required) for kind, required in kinds],
                "next": "review",
            },
            {
                "id": "review",
                "kind": "review",
                "title": "Review application",
                "controls": [],
                "finalAction": copy.deepcopy(fixture["steps"][-1]["finalAction"]),
            },
        ]
        return fixture
