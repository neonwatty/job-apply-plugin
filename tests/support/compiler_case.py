import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from qa.compiler import COMPILER_VERSION, CompilerError, compile_capture
from qa.contracts import CATALOG, FINAL_ACTION, ContractError, validate_fixture
from qa.privacy import scan_tree


TESTDATA = Path(__file__).resolve().parents[2] / "qa" / "testdata" / "private-capture"
FIXTURE_ID = "linkedin-easy-apply-short-2026-08-v1"


def source_files_digest(source_files):
    canonical = json.dumps(
        source_files, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class CompilerCase(unittest.TestCase):
    def setUp(self):
        self.capture = json.loads((TESTDATA / "semantic.json").read_text())
        self.receipt = json.loads((TESTDATA / "capture-receipt.json").read_text())

    def compile(self, capture=None, receipt=None):
        return compile_capture(
            self.capture if capture is None else capture,
            self.receipt if receipt is None else receipt,
            fixture_id=FIXTURE_ID,
        )

    def assert_rejected_without_echo(self, capture=None, receipt=None):
        private_values = (
            "PRIVATE-SENTINEL",
            "Source Employer",
            "Synthetic Applicant",
            "private-synthetic-capture",
        )
        with self.assertRaises(CompilerError) as raised:
            self.compile(capture, receipt)
        message = str(raised.exception)
        self.assertRegex(message, r"^[a-z][a-z -]+$")
        for value in private_values:
            self.assertNotIn(value, message)
        return message

    def linkedin_screening_capture(self):
        capture = copy.deepcopy(self.capture)
        capture["steps"] = [
            {
                "checkpoint": "application-opened",
                "controls": [
                    {
                        "kind": "contact.email",
                        "sourceLabel": "Email",
                        "required": True,
                    },
                    {
                        "kind": "contact.phone",
                        "sourceLabel": "Mobile",
                        "required": True,
                    },
                ],
            },
            {
                "checkpoint": "step-advanced",
                "controls": [
                    {"kind": "resume.file", "sourceLabel": "Upload", "required": True}
                ],
            },
            {
                "checkpoint": "step-advanced",
                "controls": [
                    {
                        "kind": "preference.top_choice",
                        "sourceLabel": "Top choice",
                        "required": False,
                    }
                ],
            },
            {
                "checkpoint": "step-advanced",
                "controls": [
                    {
                        "kind": "authorization.sponsorship",
                        "sourceLabel": "Private source question",
                        "required": True,
                    }
                ],
            },
            {
                "checkpoint": "review-reached",
                "controls": [],
                "finalActionObserved": True,
            },
        ]
        return capture

    def greenhouse_capture(self):
        capture = copy.deepcopy(self.capture)
        capture["platformFamily"] = "greenhouse"
        capture["steps"] = [
            {
                "checkpoint": "application-opened",
                "controls": [
                    {"kind": kind, "sourceLabel": f"Observed {index}", "required": required}
                    for index, (kind, required) in enumerate(
                        (
                            ("contact.first_name", True),
                            ("contact.last_name", True),
                            ("contact.preferred_name", False),
                            ("contact.email", True),
                            ("contact.phone_country", True),
                            ("contact.phone", True),
                            ("contact.location_city", True),
                            ("resume.file", True),
                            ("cover_letter.file", False),
                            ("profile.linkedin", True),
                            ("profile.website", False),
                            ("authorization.sponsorship_select", True),
                            ("employment.prior_affiliate", True),
                            ("source.discovery", True),
                            ("referral.contact", False),
                        ),
                        start=1,
                    )
                ],
            },
            {
                "checkpoint": "review-reached",
                "controls": [],
                "finalActionObserved": True,
            },
        ]
        return capture

    def ashby_capture(self):
        capture = copy.deepcopy(self.capture)
        capture["platformFamily"] = "ashby"
        capture["steps"] = [
            {
                "checkpoint": "application-opened",
                "controls": [
                    {"kind": "contact.full_name", "sourceLabel": "Observed 1", "required": True},
                    {"kind": "contact.email", "sourceLabel": "Observed 2", "required": True},
                    {"kind": "resume.file", "sourceLabel": "Observed 3", "required": True},
                ],
            },
            {
                "checkpoint": "review-reached",
                "controls": [],
                "finalActionObserved": True,
            },
        ]
        return capture

    def lever_capture(self):
        capture = copy.deepcopy(self.capture)
        capture["platformFamily"] = "lever"
        profile = (
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
        capture["steps"] = [
            {
                "checkpoint": "application-opened",
                "controls": [
                    {
                        "kind": kind,
                        "sourceLabel": f"Observed {index}",
                        "required": required,
                    }
                    for index, (kind, required) in enumerate(profile, start=1)
                ],
            },
            {
                "checkpoint": "review-reached",
                "controls": [],
                "finalActionObserved": True,
            },
        ]
        return capture
