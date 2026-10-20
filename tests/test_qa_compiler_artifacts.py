from tests.support.compiler_case import *


class CompilerTests(CompilerCase):
    def test_source_file_digest_is_canonical_and_content_sensitive(self):
        first = copy.deepcopy(self.receipt)
        reversed_items = reversed(list(first["sourceFiles"].items()))
        reordered = copy.deepcopy(first)
        reordered["sourceFiles"] = dict(reversed_items)
        self.assertEqual(
            self.compile(receipt=first),
            self.compile(receipt=reordered),
        )

        path_changed = copy.deepcopy(first)
        file_hash = path_changed["sourceFiles"].pop(
            "checkpoints/application-opened/page.html"
        )
        path_changed["sourceFiles"]["checkpoints/application-opened/body.html"] = (
            file_hash
        )
        hash_changed = copy.deepcopy(first)
        hash_changed["sourceFiles"]["checkpoints/application-opened/page.html"] = (
            "d" * 64
        )
        original_digest = self.compile(receipt=first)["provenance"][
            "sourceRecordingSha256"
        ]
        self.assertNotEqual(
            original_digest,
            self.compile(receipt=path_changed)["provenance"][
                "sourceRecordingSha256"
            ],
        )
        self.assertNotEqual(
            original_digest,
            self.compile(receipt=hash_changed)["provenance"][
                "sourceRecordingSha256"
            ],
        )

    def test_rejects_invalid_source_file_maps_paths_and_hashes(self):
        invalid_source_files = (
            {},
            [],
            {"": "a" * 64},
            {"/PRIVATE-SENTINEL": "a" * 64},
            {".": "a" * 64},
            {"..": "a" * 64},
            {"a/./b.html": "a" * 64},
            {"a/../b.html": "a" * 64},
            {"a\\b.html": "a" * 64},
            {"C:/capture/page.html": "a" * 64},
            {"C:\\capture\\page.html": "a" * 64},
            {"a//b.html": "a" * 64},
            {"a/PRIVATE-SENTINEL\n.html": "a" * 64},
            {"a.html": "A" * 64},
            {"a.html": "a" * 63},
            {"a.html": "g" * 64},
            {"a.html": 7},
        )
        for invalid in invalid_source_files:
            with self.subTest(invalid=invalid):
                receipt = copy.deepcopy(self.receipt)
                receipt["sourceFiles"] = invalid
                self.assert_rejected_without_echo(receipt=receipt)

    def test_source_file_work_limits_accept_boundaries_and_reject_excess(self):
        receipt = copy.deepcopy(self.receipt)
        receipt["sourceFiles"] = {"one": "a" * 64, "two": "b" * 64}
        with mock.patch("qa.compiler.MAX_SOURCE_FILES", 2):
            self.assertIsNotNone(self.compile(receipt=receipt))

            receipt["sourceFiles"]["three"] = "c" * 64
            self.assert_rejected_without_echo(receipt=receipt)

        receipt = copy.deepcopy(self.receipt)
        receipt["sourceFiles"] = {"ééé": "a" * 64}
        with mock.patch("qa.compiler.MAX_SOURCE_PATH_CHARS", 3):
            self.assertIsNotNone(self.compile(receipt=receipt))

            receipt["sourceFiles"] = {"éééé": "a" * 64}
            self.assert_rejected_without_echo(receipt=receipt)

    def test_compilation_is_deterministic_and_canonicalizable(self):
        first = json.dumps(self.compile(), sort_keys=True, separators=(",", ":"))
        second = json.dumps(self.compile(), sort_keys=True, separators=(",", ":"))
        self.assertEqual(first, second)

    def test_rejects_invalid_recorder_version(self):
        for key, invalid in (
            ("recorderVersion", ""),
            ("recorderVersion", "   "),
        ):
            with self.subTest(key=key, invalid=invalid):
                receipt = copy.deepcopy(self.receipt)
                receipt[key] = invalid
                self.assert_rejected_without_echo(receipt=receipt)

    def test_recorder_version_requires_strict_semver_core_syntax(self):
        for invalid in (
            "nonsense",
            1,
            "1",
            "1.2",
            "1.2.3 extra",
            " 1.2.3",
            "1.2.3 ",
            "\n1.2.3",
            "1.2.3\n",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            None,
        ):
            with self.subTest(invalid=invalid):
                receipt = copy.deepcopy(self.receipt)
                receipt["recorderVersion"] = invalid
                self.assert_rejected_without_echo(receipt=receipt)

        for valid in ("0.0.0", "1.0.0", "12.34.56"):
            with self.subTest(valid=valid):
                receipt = copy.deepcopy(self.receipt)
                receipt["recorderVersion"] = valid
                fixture = self.compile(receipt=receipt)
                self.assertEqual(fixture["provenance"]["recorderVersion"], valid)

    def test_rejects_duplicate_unsupported_or_out_of_order_checkpoints(self):
        variants = []
        capture = copy.deepcopy(self.capture)
        capture["steps"].insert(1, copy.deepcopy(capture["steps"][0]))
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][1]["checkpoint"] = "PRIVATE-SENTINEL"
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][0], capture["steps"][1] = (
            capture["steps"][1],
            capture["steps"][0],
        )
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"] = capture["steps"][:2]
        variants.append(capture)
        for capture in variants:
            self.assert_rejected_without_echo(capture=capture)
