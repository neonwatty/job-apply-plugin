import unittest
from pathlib import Path

from scripts.skill_documents import skill_documents, skill_text


ROOT = Path(__file__).resolve().parents[1]


class JobTitleDiscoverySkillTests(unittest.TestCase):
    def test_skill_has_reachable_references_and_safe_handoffs(self):
        entry = ROOT / 'skills/job-title-discovery/SKILL.md'
        documents = set(skill_documents(entry))
        self.assertEqual(documents, {
            entry,
            entry.parent / 'references/discovery-workflow.md',
            entry.parent / 'references/result-format.md',
        })
        text = skill_text(entry)
        for boundary in ('answer-memory', 'job-preferences', 'job-search', 'profile-inspect', 'preferences-set', 'targetTitles'):
            self.assertIn(boundary, text)
        self.assertIn('Do not write private Store files', text)
        self.assertIn('revision-checked save', text)
        self.assertIn('logged out', text)

    def test_packaged_inventory_mentions_new_skill(self):
        for relative in ('README.md', 'site/index.html', 'scripts/smoke-plugin.sh',
                         'scripts/smoke/plugin_install_verify.py', 'scripts/smoke/repository_contracts.py'):
            with self.subTest(relative=relative):
                self.assertIn('job-title-discovery', (ROOT / relative).read_text())
