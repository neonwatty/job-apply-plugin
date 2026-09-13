from tests.support.pdf_fixture import *
from tests.support.replay_case import *


class CommittedScenarioTests(CommittedScenarioCase):
    def test_pdf_inspector_rejects_denied_text_active_content_and_pages(self) -> None:
        scenario_pdf = (
            ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf"
        ).read_bytes()
        injected = append_to_pdf_content(
            scenario_pdf,
            b"BT (Source Company) Tj ET",
        )
        with self.assertRaisesRegex(AssertionError, "denied text"):
            inspect_synthetic_pdf(injected)

        active = append_to_pdf_content(
            scenario_pdf,
            b"/Type /Action /S /JavaScript",
        )
        with self.assertRaisesRegex(AssertionError, "active PDF feature"):
            inspect_synthetic_pdf(active)

        hex_text = append_to_pdf_content(
            scenario_pdf,
            b"BT <536F7572636520436F6D70616E79> Tj ET",
        )
        with self.assertRaisesRegex(AssertionError, "hex string"):
            inspect_synthetic_pdf(hex_text)

        text_array = append_to_pdf_content(
            scenario_pdf,
            b"BT [(Source) 0 (Company)] TJ ET",
        )
        with self.assertRaisesRegex(AssertionError, "text array"):
            inspect_synthetic_pdf(text_array)

        unsupported_filter = scenario_pdf.replace(
            b"/Filter [ /FlateDecode ]",
            b"/Filter [ /ASCII85Decode ]",
            1,
        )
        self.assertNotEqual(unsupported_filter, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "content stream filter"):
            inspect_synthetic_pdf(unsupported_filter)

        unsupported_encoding = scenario_pdf.replace(
            b"/Encoding /WinAnsiEncoding",
            b"/Encoding /MacRomanEncoding",
            1,
        )
        self.assertNotEqual(unsupported_encoding, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "active PDF feature"):
            inspect_synthetic_pdf(unsupported_encoding)

        duplicate_kid = scenario_pdf.replace(
            b"/Kids [ 4 0 R ]",
            b"/Kids [ 4 0 R 4 0 R ]",
            1,
        )
        self.assertNotEqual(duplicate_kid, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "one unique page kid"):
            inspect_synthetic_pdf(duplicate_kid)

    def test_pdf_inspector_rejects_hidden_metadata_and_trailing_bytes(self) -> None:
        scenario_pdf = (
            ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf"
        ).read_bytes()
        for original, replacement in (
            (b"(Fictional QA Applicant)", b"(Source Company)"),
            (b"(Fictional QA Applicant)", b"(Private Person)"),
            (b"(Synthetic Resume)", b"(Hidden Value)"),
            (b"(Synthetic profile fixture)", b"(Confidential Value)"),
        ):
            with self.subTest(replacement=replacement):
                tampered = scenario_pdf.replace(original, replacement, 1)
                self.assertNotEqual(tampered, scenario_pdf)
                with self.assertRaisesRegex(AssertionError, "Info dictionary value"):
                    inspect_synthetic_pdf(tampered)

        xmp = scenario_pdf.replace(
            b"trailer\n",
            b"99 0 obj\n<< /Type /Metadata /Subtype /XML >>\nendobj\ntrailer\n",
            1,
        )
        self.assertNotEqual(xmp, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "active PDF feature"):
            inspect_synthetic_pdf(xmp)

        extra_info = scenario_pdf.replace(
            b"trailer\n",
            b"99 0 obj\n<< /Author (Fictional QA Applicant) >>\nendobj\ntrailer\n",
            1,
        )
        self.assertNotEqual(extra_info, scenario_pdf)
        with self.assertRaisesRegex(AssertionError, "extra metadata dictionary"):
            inspect_synthetic_pdf(extra_info)

        hidden_comment = scenario_pdf.replace(
            b"trailer\n",
            b"% Source Company\ntrailer\n",
            1,
        )
        with self.assertRaisesRegex(AssertionError, "denied text"):
            inspect_synthetic_pdf(hidden_comment)

        for trailing in (
            b"% https://private.invalid\n",
            b"% hidden comment\n",
            b"unexpected bytes",
        ):
            with self.subTest(trailing=trailing):
                with self.assertRaisesRegex(AssertionError, "physical EOF"):
                    inspect_synthetic_pdf(scenario_pdf + trailing)

    def test_reviewed_digest_rejects_arbitrary_catalog_and_page_names(self) -> None:
        scenario_pdf = (
            ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf"
        ).read_bytes()
        for original, replacement in (
            (
                b"/PageMode /UseNone",
                b"/PageMode /UseNone /HiddenCatalogName /HiddenValue",
            ),
            (
                b"/Rotate 0",
                b"/Rotate 0 /HiddenPageName /HiddenValue",
            ),
        ):
            with self.subTest(replacement=replacement):
                tampered = scenario_pdf.replace(original, replacement, 1)
                self.assertNotEqual(tampered, scenario_pdf)
                with self.assertRaisesRegex(AssertionError, "digest changed"):
                    validate_committed_synthetic_pdf(tampered)
