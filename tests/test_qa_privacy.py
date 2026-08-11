import contextlib
import io
import os
from pathlib import Path
import tempfile
import unittest

from qa.privacy import ALLOWED_SUFFIXES, PrivacyError, scan_tree


TESTDATA = Path(__file__).resolve().parents[1] / "qa" / "testdata" / "privacy"


class PrivacyScannerTests(unittest.TestCase):
    def scan_text(self, content, *, suffix=".txt", denied_terms=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / f"candidate{suffix}").write_bytes(content)
            with self.assertRaises(PrivacyError) as raised:
                scan_tree(root, denied_terms or [])
            return str(raised.exception)

    def test_detects_private_content_by_category_without_echoing_values(self):
        private_sentinel = "PRIVATE-VALUE-DO-NOT-ECHO"
        cases = (
            ("email", b"person@example.invalid", []),
            ("phone", b"+1 (202) 555-0198", []),
            ("source-url", b"https://www.linkedin.com/jobs/view/123", []),
            ("source-url", b"https://careers.example.invalid/job/123", []),
            ("source-url", b"/jobs/fictional-role", []),
            ("credential", b"Bearer fictional-token-value", []),
            ("credential", b"Cookie: session=fake", []),
            ("credential", b"Set-Cookie: session=fake", []),
            ("credential", b"Authorization: Basic fictional", []),
            ("credential", b'{"header":"Cookie: session=fake"}', []),
            ("credential", b'{"cookie":"PRIVATE-VALUE-DO-NOT-ECHO"}', [], ".json"),
            (
                "credential",
                b'{"authorization":"PRIVATE-VALUE-DO-NOT-ECHO"}',
                [],
                ".json",
            ),
            (
                "credential",
                b'{"set-cookie":"PRIVATE-VALUE-DO-NOT-ECHO"}',
                [],
                ".json",
            ),
            (
                "credential",
                b"{'cookie': 'PRIVATE-VALUE-DO-NOT-ECHO'}",
                [],
                ".js",
            ),
            ("credential", b"cookie=PRIVATE-VALUE-DO-NOT-ECHO", []),
            ("credential", b"authorization=PRIVATE-VALUE-DO-NOT-ECHO", []),
            ("credential", b"set-cookie=PRIVATE-VALUE-DO-NOT-ECHO", []),
            ("denied-term-0", private_sentinel.encode(), [private_sentinel]),
            ("source-html", b'<script src="/fictional.js"></script>', []),
            ("source-html", b"linkedin-logo", []),
            ("source-html", b"voyager-web", []),
            ("unexpected-file-type", b"generic\x00binary", []),
            ("unexpected-suffix", b"generic content", [], ".md"),
        )

        for index, case in enumerate(cases):
            category, content, denied_terms, *suffix = case
            with self.subTest(index=index, category=category):
                stdout = io.StringIO()
                stderr = io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    message = self.scan_text(
                        content,
                        suffix=suffix[0] if suffix else ".txt",
                        denied_terms=denied_terms,
                    )
                self.assertEqual(
                    message,
                    f"privacy scan failed: {category}:candidate"
                    f"{suffix[0] if suffix else '.txt'}",
                )
                captured = stdout.getvalue() + stderr.getvalue() + message
                self.assertNotIn(private_sentinel, captured)
                self.assertNotIn(content.decode("utf-8", errors="ignore"), message)

    def test_clean_generic_fixture_tree_passes(self):
        self.assertIsNone(scan_tree(TESTDATA / "clean", []))

    def test_credential_words_in_ordinary_prose_are_not_assignments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "candidate.txt").write_text(
                "Generic authorization guidance and cookie preferences are available."
            )
            self.assertIsNone(scan_tree(root, []))

    def test_leak_corpus_has_one_expected_category_per_file(self):
        cases = {
            "credential.txt": "credential",
            "denied-term.txt": "denied-term-0",
            "email.txt": "email",
            "phone.txt": "phone",
            "source-html.html": "source-html",
            "source-url.txt": "source-url",
            "unexpected.bin": "unexpected-suffix",
        }
        leak_root = TESTDATA / "leaks"
        for filename, category in cases.items():
            with self.subTest(filename=filename):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / filename).write_bytes((leak_root / filename).read_bytes())
                    terms = (
                        ["FICTIONAL APPLICANT"]
                        if filename == "denied-term.txt"
                        else []
                    )
                    with self.assertRaisesRegex(
                        PrivacyError,
                        f"^privacy scan failed: {category}:{filename}$",
                    ):
                        scan_tree(root, terms)

    def test_missing_and_non_directory_roots_hide_absolute_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            missing = parent / "PRIVATE-MISSING-ROOT"
            regular_file = parent / "PRIVATE-NOT-A-DIRECTORY.txt"
            regular_file.write_text("generic")
            for root in (missing, regular_file):
                with self.subTest(root=root.name):
                    with self.assertRaisesRegex(
                        PrivacyError, "^privacy scan failed: root:.$"
                    ) as raised:
                        scan_tree(root, [])
                    self.assertNotIn(str(root), str(raised.exception))
                    self.assertNotIn(root.name, str(raised.exception))

    def test_unreadable_file_fails_closed_when_permissions_are_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate.txt"
            candidate.write_text("generic")
            candidate.chmod(0)
            try:
                if os.access(candidate, os.R_OK):
                    self.skipTest("platform does not enforce unreadable test file")
                with self.assertRaisesRegex(
                    PrivacyError, "^privacy scan failed: unreadable:candidate.txt$"
                ):
                    scan_tree(root, [])
            finally:
                candidate.chmod(0o600)

    def test_symlink_files_and_directories_are_refused_without_reading_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            outside_file = parent / "PRIVATE-OUTSIDE.txt"
            outside_dir = parent / "PRIVATE-OUTSIDE-DIR"
            outside_file.write_text("PRIVATE-TARGET-CONTENT")
            outside_dir.mkdir()
            (outside_dir / "secret.txt").write_text("PRIVATE-TARGET-CONTENT")

            for name, target in (
                ("file.txt", outside_file),
                ("directory", outside_dir),
            ):
                with self.subTest(name=name):
                    root = parent / f"root-{name.replace('.', '-')}"
                    root.mkdir()
                    (root / name).symlink_to(target, target_is_directory=target.is_dir())
                    with self.assertRaisesRegex(
                        PrivacyError, f"^privacy scan failed: symlink:{name}$"
                    ) as raised:
                        scan_tree(root, [])
                    message = str(raised.exception)
                    self.assertNotIn("PRIVATE-TARGET-CONTENT", message)
                    self.assertNotIn(str(target), message)

    def test_denied_terms_are_case_insensitive(self):
        message = self.scan_text(
            b"fictional applicant", denied_terms=["FiCtIoNaL ApPlIcAnT"]
        )
        self.assertEqual(message, "privacy scan failed: denied-term-0:candidate.txt")

    def test_duplicate_findings_are_deduplicated(self):
        message = self.scan_text(b"first@example.invalid second@example.invalid")
        self.assertEqual(message, "privacy scan failed: email:candidate.txt")

    def test_diagnostics_are_deterministic_and_sorted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "z.txt").write_text("z@example.invalid")
            (root / "a.txt").write_text("Bearer fictional")
            with self.assertRaises(PrivacyError) as raised:
                scan_tree(root, [])
        self.assertEqual(
            str(raised.exception),
            "privacy scan failed: credential:a.txt, email:z.txt",
        )

    def test_only_documented_text_suffixes_are_allowed(self):
        self.assertEqual(ALLOWED_SUFFIXES, {".json", ".html", ".css", ".js", ".txt"})
        for suffix in sorted(ALLOWED_SUFFIXES):
            with self.subTest(suffix=suffix):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / f"candidate{suffix}").write_text("generic fixture content")
                    self.assertIsNone(scan_tree(root, []))

        message = self.scan_text(b"generic fixture content", suffix=".TXT")
        self.assertEqual(message, "privacy scan failed: unexpected-suffix:candidate.TXT")


if __name__ == "__main__":
    unittest.main()
