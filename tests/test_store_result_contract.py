"""Cross-platform regressions for paired Store result comparison."""

import copy
import unittest
from pathlib import PurePosixPath, PureWindowsPath

from tests.support.store_result_contract import normalize_store_result


class StoreResultContractTests(unittest.TestCase):
    def test_windows_paths_are_normalized_before_escaping(self):
        left = PureWindowsPath(r"C:\Users\synthetic\original")
        right = PureWindowsPath(r"C:\Users\synthetic\extracted")
        outcomes = [
            {"root": str(root), "nested": [{"path": str(root / "resume-files" / "resume.pdf")}],
             "revision": 2, "valid": True, "missing": None}
            for root in (left, right)
        ]
        before = copy.deepcopy(outcomes)
        normalized = [normalize_store_result(value, root)
                      for value, root in zip(outcomes, (left, right))]
        self.assertEqual(normalized[0], normalized[1])
        self.assertEqual(normalized[0]["nested"][0]["path"], r"<STORE_ROOT>\resume-files\resume.pdf")
        self.assertEqual(outcomes, before)
        self.assertEqual(normalized[0]["revision"], 2)
        self.assertIs(normalized[0]["valid"], True)
        self.assertIsNone(normalized[0]["missing"])

    def test_only_exact_root_value_prefixes_change(self):
        for root in (PurePosixPath("/tmp/store"), PureWindowsPath(r"C:\temp\store")):
            with self.subTest(root=root):
                root_text = str(root)
                unchanged = {
                    root_text: "key must stay unchanged",
                    "lookalike": root_text + "-other/file",
                    "embedded": "note: " + root_text + "/file",
                    "relative": "resume-files/file",
                }
                self.assertEqual(normalize_store_result(unchanged, root), unchanged)
                self.assertEqual(normalize_store_result((root_text,), root), ("<STORE_ROOT>",))

    def test_normalization_preserves_non_root_differences(self):
        left = {"path": "/tmp/left/resume.pdf", "revision": 2}
        for right in (
            {"path": "/tmp/right/other.pdf", "revision": 2},
            {"path": "/tmp/right/resume.pdf", "revision": 3},
        ):
            self.assertNotEqual(normalize_store_result(left, "/tmp/left"),
                                normalize_store_result(right, "/tmp/right"))
