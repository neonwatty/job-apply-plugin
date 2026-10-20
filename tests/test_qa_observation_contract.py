from tests.support.contract_case import *


class ContractTests(ContractCase):
    def test_committed_greenhouse_readiness_fixture_is_closed(self):
        fixture = json.loads(
            (
                ROOT
                / "qa/fixtures/greenhouse-form-readiness-v1/fixture.json"
            ).read_text(encoding="utf-8")
        )
        self.assertIsNone(validate_fixture(fixture))
        self.assertEqual(fixture["platformFamily"], "greenhouse")
        self.assertEqual(
            [
                control["role"]
                for step in fixture["steps"]
                for control in step["controls"]
            ],
            ["textbox", "combobox", "file", "combobox", "textbox"],
        )

    def test_committed_workday_and_rippling_readiness_fixtures_are_closed(self):
        for fixture_id, platform in (
            ("workday-form-readiness-v1", "workday"),
            ("rippling-form-readiness-v1", "rippling"),
        ):
            with self.subTest(platform=platform):
                fixture = json.loads((
                    ROOT / "qa" / "fixtures" / fixture_id / "fixture.json"
                ).read_text(encoding="utf-8"))
                self.assertIsNone(validate_fixture(fixture))
                self.assertEqual(fixture["platformFamily"], platform)

    def test_readiness_observation_contract_is_closed_and_revisioned(self):
        fixture = self.valid_greenhouse_fixture()
        observation = {
            "schemaVersion": 1,
            "platformFamily": "greenhouse",
            "observationRevision": 3,
            "adapterState": "accessible",
            "uploadCapability": "available",
            "controls": [
                {
                    "controlId": "contact.first_name",
                    "kind": "text",
                    "state": "complete",
                    "observationRevision": 3,
                },
                {
                    "controlId": "contact.phone_country",
                    "kind": "selection",
                    "state": "complete",
                    "observationRevision": 3,
                },
                {
                    "controlId": "resume.file",
                    "kind": "upload",
                    "state": "accepted",
                    "observationRevision": 3,
                },
            ],
            "validationErrorControlIds": [],
            "finalControlState": "available",
        }
        self.assertIsNone(validate_readiness_observation(observation, fixture))

        private = copy.deepcopy(observation)
        private["controls"][0]["value"] = "PRIVATE"
        with self.assertRaisesRegex(
            ContractError, "^unknown readiness control key: value$"
        ) as raised:
            validate_readiness_observation(private, fixture)
        self.assertNotIn("PRIVATE", str(raised.exception))

    def test_readiness_observation_rejects_kind_and_platform_drift(self):
        fixture = self.valid_greenhouse_fixture()
        base = {
            "schemaVersion": 1,
            "platformFamily": "greenhouse",
            "observationRevision": 1,
            "adapterState": "accessible",
            "uploadCapability": "not-required",
            "controls": [
                {
                    "controlId": "contact.first_name",
                    "kind": "text",
                    "state": "complete",
                    "observationRevision": 1,
                }
            ],
            "validationErrorControlIds": [],
            "finalControlState": "available",
        }
        wrong_kind = copy.deepcopy(base)
        wrong_kind["controls"][0]["kind"] = "upload"
        with self.assertRaisesRegex(
            ContractError, "^readiness control kind mismatch$"
        ):
            validate_readiness_observation(wrong_kind, fixture)

        wrong_platform = copy.deepcopy(base)
        wrong_platform["platformFamily"] = "ashby"
        with self.assertRaisesRegex(
            ContractError, "^readiness platform family mismatch$"
        ):
            validate_readiness_observation(wrong_platform, fixture)


class ResumeExtractionOnboardingOracleTest(unittest.TestCase):
    def test_oracle_emits_only_closed_value_free_proof(self):
        completed = subprocess.run(
            [sys.executable, str(RESUME_ONBOARDING_ORACLE), "--json"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, "")
        receipt = json.loads(completed.stdout)
        self.assertEqual(
            set(receipt),
            {
                "requestShared", "autofillObserved", "conflictsReviewed",
                "profileShared", "contentChangeStaled", "racesRejected",
                "privacyVerified", "agentStoppedAtReview", "passed",
            },
        )
        self.assertTrue(all(receipt.values()))
        serialized = completed.stdout.lower()
        for forbidden in (
            "owner-like-redacted", "candidate", "fixture@example", "digest",
            "contentrevision", "traceback", str(Path.home()).lower(),
        ):
            self.assertNotIn(forbidden, serialized)

    def test_oracle_rejects_absolute_fixture_and_non_temporary_store(self):
        fixture = ROOT / "qa" / "testdata" / "resumes" / "owner-like-redacted.pdf"
        for args in (
            ("--fixture", str(fixture)),
            ("--store-root", str(Path.home() / ".job-apply")),
        ):
            with self.subTest(args=args):
                completed = subprocess.run(
                    [sys.executable, str(RESUME_ONBOARDING_ORACLE), "--json", *args],
                    cwd=ROOT,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertNotEqual(completed.returncode, 0)
                self.assertNotIn(str(Path.home()), completed.stdout + completed.stderr)
                receipt = json.loads(completed.stdout)
                self.assertEqual(set(receipt), {
                    "requestShared", "autofillObserved", "conflictsReviewed",
                    "profileShared", "contentChangeStaled", "racesRejected",
                    "privacyVerified", "agentStoppedAtReview", "passed",
                })
                self.assertFalse(receipt["passed"])

        with tempfile.TemporaryDirectory(prefix="resume-oracle-contract-") as temporary:
            completed = subprocess.run(
                [
                    sys.executable, str(RESUME_ONBOARDING_ORACLE), "--json",
                    "--store-root", str(Path(temporary) / "store"),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(json.loads(completed.stdout)["passed"])
