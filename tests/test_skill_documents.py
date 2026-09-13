"""Check reference reachability rather than freezing entry-point prose."""
import tempfile
import unittest
from pathlib import Path
from scripts.skill_documents import skill_documents


class SkillDocumentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.skills = Path(self.temporary.name).resolve() / 'skills'
        self.root = self.skills / 'example'
        (self.root / 'references').mkdir(parents=True)
        self.entry = self.root / 'SKILL.md'

    def test_reachable_reference_cycle_is_read_once(self):
        self.entry.write_text('[Details](references/details.md)\n')
        detail = self.root / 'references/details.md'
        detail.write_text('[Root](../SKILL.md)\n')
        self.assertEqual(set(skill_documents(self.entry)), {self.entry, detail})

    def test_missing_reference_fails(self):
        self.entry.write_text('[Details](references/missing.md)\n')
        with self.assertRaises(FileNotFoundError):
            skill_documents(self.entry)

    def test_unlinked_reference_fails(self):
        self.entry.write_text('# Example\n')
        (self.root / 'references/forgotten.md').write_text('Required procedure\n')
        with self.assertRaisesRegex(ValueError, 'unreachable'):
            skill_documents(self.entry)

    def test_external_skill_link_is_checked_but_not_eagerly_loaded(self):
        sibling = self.skills / 'sibling'
        sibling.mkdir()
        (sibling / 'SKILL.md').write_text('Separate workflow\n')
        self.entry.write_text('[Sibling](../sibling/SKILL.md)\n')
        self.assertEqual(set(skill_documents(self.entry)), {self.entry})

    def test_reference_cannot_escape_skill_package(self):
        outside = Path(self.temporary.name) / 'outside.md'
        outside.write_text('Unrelated\n')
        self.entry.write_text('[Outside](../../outside.md)\n')
        with self.assertRaisesRegex(ValueError, 'escapes'):
            skill_documents(self.entry)

    def test_all_packaged_skill_references_are_reachable(self):
        root = Path(__file__).resolve().parents[1]
        for entry in (root / 'skills').glob('*/SKILL.md'):
            with self.subTest(skill=entry.parent.name):
                self.assertTrue(skill_documents(entry))
