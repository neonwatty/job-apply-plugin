import unittest
from pathlib import Path

from scripts.skill_documents import skill_documents, skill_text


ROOT = Path(__file__).resolve().parents[1]


class SearchSavedSkillsTests(unittest.TestCase):
    def test_search_references_cover_sources_model_scope_and_queue_boundary(self):
        entry = ROOT / 'skills/job-search/SKILL.md'
        documents = set(skill_documents(entry))
        self.assertEqual(documents, {
            entry,
            entry.parent / 'references/sources.md',
            entry.parent / 'references/worker-results.md',
            entry.parent / 'references/model-defaults.md',
            entry.parent / 'references/queue.md',
        })
        text = skill_text(entry)
        for expected in (
            'preferences-get', 'targetTitles', 'LinkedIn', 'Hacker News',
            'Twitter/X', 'Codex', 'Claude Code', 'hacker-news.firebaseio.com',
            'agentModelPreferences', 'codex', 'claudeCode', 'search',
            'application', 'profile-patch', '--expected-revision',
            'job-upsert-preview', 'job-upsert-commit',
        ):
            self.assertIn(expected, text)
        self.assertIn('TypeScript Store CLI only previews and commits', text)
        self.assertIn('worker result contract', text)
        self.assertIn('capability', text)
        self.assertIn('On every search, read [model defaults]', entry.read_text())
        self.assertIn('saved worker model cannot change the active task model', text)

    def test_saved_jobs_is_canonical_read_only_entry_point(self):
        entry = ROOT / 'skills/saved-jobs/SKILL.md'
        self.assertEqual(set(skill_documents(entry)), {entry})
        text = skill_text(entry)
        self.assertIn('store job-list --status saved', text)
        self.assertIn('job-list --trashed-only', text)
        self.assertIn('job-list --include-trashed', text)
        self.assertIn('Trash is not a status', text)
        self.assertIn('exact canonical job ID', text)
        self.assertIn('filter the returned records in memory', text)
        self.assertIn('It never searches sites', text)
        self.assertNotIn('job-upsert-commit', text)


if __name__ == '__main__':
    unittest.main()
