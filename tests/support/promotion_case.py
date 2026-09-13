from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import qa.promote as promotion
from qa.promote import (
    PromotionError,
    approve_candidate,
    compile_candidate,
    promote_candidate,
)
from qa.recorder_fs import BrokerError


FIXTURE_ID = "linkedin-easy-apply-short-2026-08-v1"
NOW = "2026-08-11T12:00:00Z"


class PromotionCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.private = self.root / ".qa-private"
        self.session = self.private / "qa-session-20260811-001"
        self.candidate = self.session / "candidate"
        self.destination = self.root / "qa" / "fixtures"
        self.session.mkdir(parents=True)
        os.chmod(self.private, 0o700)
        os.chmod(self.session, 0o700)
        self.destination.mkdir(parents=True)
        self._write_private_inputs()
        compile_candidate(self.session, FIXTURE_ID, self.candidate)

    def _write_private_inputs(self, denied_terms: list[str] | None = None) -> None:
        semantic = {
            "captureId": "capture-001",
            "platformFamily": "linkedin-easy-apply",
            "captureMonth": "2026-08",
            "sourceDeniedTerms": denied_terms or ["Private Person", "Example Corp"],
            "steps": [
                {
                    "checkpoint": "application-opened",
                    "controls": [
                        {"kind": "contact.first_name", "sourceLabel": "Given name", "required": True},
                        {"kind": "contact.last_name", "sourceLabel": "Family name", "required": True},
                        {"kind": "contact.email", "sourceLabel": "Email", "required": True},
                        {"kind": "contact.phone", "sourceLabel": "Phone", "required": True},
                    ],
                },
                {
                    "checkpoint": "step-advanced",
                    "controls": [
                        {"kind": "resume.file", "sourceLabel": "Resume", "required": True},
                    ],
                },
                {
                    "checkpoint": "review-reached",
                    "controls": [],
                    "finalActionObserved": True,
                },
            ],
        }
        receipt = {
            "recorderVersion": "1.0.0",
            "captureMonth": "2026-08",
            "captureId": "capture-001",
            "sourceFiles": {"checkpoints/001.json": "a" * 64},
        }
        (self.session / "semantic.json").write_text(json.dumps(semantic), encoding="utf-8")
        (self.session / "capture-receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
