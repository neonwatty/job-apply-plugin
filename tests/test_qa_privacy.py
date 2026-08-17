import contextlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

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
            ("source-url", b"https://jobs.ashbyhq.com/fictional/role", []),
            ("source-url", b"https://lever.co/fictional/role", []),
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
            (
                "credential",
                b'{"cookies":[{"name":"li_at","value":"fictional-secret"}]}',
                [],
                ".json",
            ),
            (
                "credential",
                b'{"headers":[["Cookie","fictional-secret"]]}',
                [],
                ".json",
            ),
            ("credential", b"document.cookie", [], ".js"),
            ("denied-term-0", private_sentinel.encode(), [private_sentinel]),
            ("source-html", b'<script src="/fictional.js"></script>', []),
            ("source-html", b"linkedin-logo", []),
            ("source-html", b"voyager-web", []),
            ("source-html", b"ashby-logo", []),
            ("source-html", b"lever-logo", []),
            ("unexpected-file-type", b"generic\x00binary", []),
            ("unexpected-file-type", b"generic\xffbinary", []),
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
                    f'privacy scan failed: {category}:"candidate'
                    f'{suffix[0] if suffix else ".txt"}"',
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

    def test_phone_like_digits_inside_sha256_are_not_phone_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "candidate.json").write_text(
                '{"sourceRecordingSha256":'
                '"77e6f32a2c0785eed267fb1ff0e6f4140bc7ba3b0f608ba24da9fa2907724819"}'
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
        self.assertEqual(
            {path.name for path in leak_root.iterdir()},
            set(cases),
        )
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
                        f'^privacy scan failed: {category}:"{filename}"$',
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
                        PrivacyError, '^privacy scan failed: root:"."$'
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
                    PrivacyError,
                    '^privacy scan failed: unreadable:"candidate.txt"$',
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
                        PrivacyError,
                        f'^privacy scan failed: symlink:"{name}"$',
                    ) as raised:
                        scan_tree(root, [])
                    message = str(raised.exception)
                    self.assertNotIn("PRIVATE-TARGET-CONTENT", message)
                    self.assertNotIn(str(target), message)

    def test_denied_terms_are_case_insensitive(self):
        message = self.scan_text(
            b"fictional applicant", denied_terms=["FiCtIoNaL ApPlIcAnT"]
        )
        self.assertEqual(
            message, 'privacy scan failed: denied-term-0:"candidate.txt"'
        )

    def test_denied_terms_use_unicode_casefolding(self):
        cases = (
            ("ÉLODIE", "élodie"),
            ("ПРИВЕТ", "привет"),
        )
        for content, denied_term in cases:
            with self.subTest(script=denied_term.encode("unicode_escape")):
                message = self.scan_text(
                    content.encode("utf-8"), denied_terms=[denied_term]
                )
                self.assertEqual(
                    message, 'privacy scan failed: denied-term-0:"candidate.txt"'
                )

    def test_duplicate_findings_are_deduplicated(self):
        message = self.scan_text(b"first@example.invalid second@example.invalid")
        self.assertEqual(message, 'privacy scan failed: email:"candidate.txt"')

    def test_diagnostics_are_deterministic_and_sorted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "z.txt").write_text("z@example.invalid")
            (root / "a.txt").write_text("Bearer fictional")
            with self.assertRaises(PrivacyError) as raised:
                scan_tree(root, [])
        self.assertEqual(
            str(raised.exception),
            'privacy scan failed: credential:"a.txt", email:"z.txt"',
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
        self.assertEqual(
            message, 'privacy scan failed: unexpected-suffix:"candidate.TXT"'
        )

    def test_resource_limits_accept_boundaries_and_reject_excess(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.txt").write_bytes(b"abc")
            with mock.patch("qa.privacy.MAX_FILES", 1), mock.patch(
                "qa.privacy.MAX_FILE_BYTES", 3
            ), mock.patch("qa.privacy.MAX_TOTAL_BYTES", 3):
                self.assertIsNone(scan_tree(root, []))

                (root / "b.txt").write_bytes(b"")
                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: limit-file-count:"b.txt"$',
                ):
                    scan_tree(root, [])

            (root / "b.txt").unlink()
            (root / "a.txt").write_bytes(b"abcd")
            with mock.patch("qa.privacy.MAX_FILE_BYTES", 3):
                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: limit-file-bytes:"a.txt"$',
                ):
                    scan_tree(root, [])

            (root / "a.txt").write_bytes(b"abc")
            (root / "b.txt").write_bytes(b"def")
            with mock.patch("qa.privacy.MAX_TOTAL_BYTES", 5):
                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: limit-total-bytes:"b.txt"$',
                ):
                    scan_tree(root, [])

    def test_denied_term_limits_accept_boundaries_and_reject_excess(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "candidate.txt").write_text("generic")
            with mock.patch("qa.privacy.MAX_DENIED_TERMS", 1), mock.patch(
                "qa.privacy.MAX_DENIED_TERM_CHARS", 3
            ):
                self.assertIsNone(scan_tree(root, ["abc"]))

                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: limit-denied-term-count:"."$',
                ):
                    scan_tree(root, ["abc", "def"])

                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: limit-denied-term-length:"."$',
                ):
                    scan_tree(root, ["abcd"])

    def test_entry_swapped_to_symlink_is_refused_without_reading_target(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            root = parent / "root"
            root.mkdir()
            candidate = root / "candidate.txt"
            candidate.write_text("generic fixture content")
            target = parent / "outside.txt"
            private_sentinel = "PRIVATE-SWAPPED-TARGET"
            target.write_text(private_sentinel)
            real_open = os.open
            swapped = False

            def swap_before_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal swapped
                if path == "candidate.txt" and dir_fd is not None and not swapped:
                    swapped = True
                    candidate.unlink()
                    candidate.symlink_to(target)
                return real_open(path, flags, mode, dir_fd=dir_fd)

            with mock.patch("qa.privacy.os.open", side_effect=swap_before_open):
                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: unsafe-entry:"candidate.txt"$',
                ) as raised:
                    scan_tree(root, [])
            self.assertTrue(swapped)
            self.assertNotIn(private_sentinel, str(raised.exception))
            self.assertNotIn(str(target), str(raised.exception))

    def test_control_characters_in_relative_paths_are_json_escaped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "line\nbreak.txt").write_text("person@example.invalid")
            with self.assertRaises(PrivacyError) as raised:
                scan_tree(root, [])
        message = str(raised.exception)
        self.assertEqual(message, 'privacy scan failed: email:"line\\nbreak.txt"')
        self.assertNotIn("\n", message)

    def test_missing_descriptor_primitives_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "candidate.txt").write_text("generic fixture content")
            with mock.patch("qa.privacy._DESCRIPTOR_TRAVERSAL_AVAILABLE", False):
                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: unsupported-platform:"."$',
                ):
                    scan_tree(root, [])

    def test_entry_limit_counts_every_entry_type_and_has_one_diagnostic(self):
        creators = {
            "directory": lambda root, parent: (root / "entry").mkdir(),
            "symlink": lambda root, parent: (root / "entry").symlink_to(
                parent / "outside"
            ),
        }
        if hasattr(os, "mkfifo"):
            creators["special"] = lambda root, parent: os.mkfifo(root / "entry")

        for entry_type, create_entry in creators.items():
            with self.subTest(entry_type=entry_type):
                with tempfile.TemporaryDirectory() as directory:
                    parent = Path(directory)
                    root = parent / "root"
                    root.mkdir()
                    (parent / "outside").write_text("PRIVATE-OUTSIDE")
                    create_entry(root, parent)
                    with mock.patch("qa.privacy.MAX_ENTRIES", 0):
                        with self.assertRaises(PrivacyError) as raised:
                            scan_tree(root, [])
                    self.assertEqual(
                        str(raised.exception),
                        'privacy scan failed: limit-entry-count:"."',
                    )

    def test_entry_limit_stops_and_discards_prior_findings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.txt").write_text("person@example.invalid")
            nested = root / "z"
            nested.mkdir()
            (nested / "a.txt").write_text("generic")
            (nested / "b.txt").write_text("generic")
            with mock.patch("qa.privacy.MAX_ENTRIES", 3):
                with self.assertRaises(PrivacyError) as raised:
                    scan_tree(root, [])
        self.assertEqual(
            str(raised.exception),
            'privacy scan failed: limit-entry-count:"."',
        )

    def test_entry_limit_accepts_boundary_and_rejects_next_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.txt").write_text("generic")
            with mock.patch("qa.privacy.MAX_ENTRIES", 1):
                self.assertIsNone(scan_tree(root, []))
                (root / "b.txt").write_text("generic")
                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: limit-entry-count:"."$',
                ):
                    scan_tree(root, [])

    def test_wide_tree_keeps_open_directory_descriptors_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(12):
                (root / f"directory-{index:02d}").mkdir()

            real_open = os.open
            real_close = os.close
            active_descriptors = set()
            maximum_active = 0

            def tracked_open(*args, **kwargs):
                nonlocal maximum_active
                descriptor = real_open(*args, **kwargs)
                active_descriptors.add(descriptor)
                maximum_active = max(maximum_active, len(active_descriptors))
                return descriptor

            def tracked_close(descriptor):
                active_descriptors.discard(descriptor)
                return real_close(descriptor)

            with mock.patch("qa.privacy.os.open", side_effect=tracked_open), mock.patch(
                "qa.privacy.os.close", side_effect=tracked_close
            ):
                self.assertIsNone(scan_tree(root, []))
            self.assertEqual(active_descriptors, set())
            self.assertLessEqual(maximum_active, 2)

    def test_depth_limit_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "nested").mkdir()
            with mock.patch("qa.privacy.MAX_DEPTH", 0):
                with self.assertRaisesRegex(
                    PrivacyError,
                    '^privacy scan failed: limit-depth:"nested"$',
                ):
                    scan_tree(root, [])

    def test_comma_and_colon_in_relative_path_cannot_forge_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "comma,name:part.txt").write_text("person@example.invalid")
            with self.assertRaises(PrivacyError) as raised:
                scan_tree(root, [])
        self.assertEqual(
            str(raised.exception),
            'privacy scan failed: email:"comma,name:part.txt"',
        )


if __name__ == "__main__":
    unittest.main()
