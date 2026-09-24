"""Search selection and preference edits share Companion's canonical state."""
from tests.support.workspace_case import *


class SearchHandoffTests(WorkspaceCase):
    def cli(self, command, *args, payload=None):
        result = subprocess.run(
            [sys.executable, str(ROOT / 'scripts/job-apply-store.py'),
             '--root', str(self.store_root), command, *args,
             *(['--input', '-'] if payload is not None else [])],
            input=json.dumps(payload) if payload is not None else None,
            capture_output=True, text=True, check=True,
        )
        return json.loads(result.stdout)

    def test_partial_preferences_from_agent_are_visible_in_companion(self):
        inspection = self.cli('profile-inspect')
        updated = self.cli(
            'preferences-set', '--expected-revision', str(inspection['revision']),
            '--source', 'user', payload={'targetTitles': ['Python Engineer']},
        )
        status, _, visible = self.request('GET', '/api/profile', origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(visible['profile']['preferences'], {'targetTitles': ['Python Engineer']})
        self.assertEqual(visible['revision'], updated['revision'])
        changed = self.cli(
            'preferences-set', '--expected-revision', str(visible['revision']),
            '--source', 'user', payload={'remotePreference': 'remote only'},
        )
        status, _, visible = self.request('GET', '/api/profile', origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(visible['profile']['preferences'], {
            'targetTitles': ['Python Engineer'], 'remotePreference': 'remote only',
        })
        self.assertEqual(visible['revision'], changed['revision'])

    def test_owner_review_patch_is_selective_revision_checked_and_reused_by_search(self):
        initial = self.cli('profile-inspect')
        seeded = self.cli('preferences-set', '--expected-revision', str(initial['revision']),
                          '--source', 'user', payload={'targetTitles': ['Existing Role'],
                                                       'remotePreference': 'remote only',
                                                       'salaryMin': 180000})
        status, _, before = self.request('GET', '/api/profile', origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(before['revision'], seeded['revision'])
        # Discovery and cancellation only read. The owner-selected exact set is the patch.
        status, _, inspected = self.request('GET', '/api/profile', origin=False)
        self.assertEqual((status, inspected), (200, before))
        patch = {'expectedRevision': before['revision'],
                 'patch': {'preferences': {'targetTitles': ['Existing Role', 'Staff ML Engineer']}}}
        status, _, saved = self.request('PATCH', '/api/profile', patch)
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved['profile']['preferences'], {
            'targetTitles': ['Existing Role', 'Staff ML Engineer'],
            'remotePreference': 'remote only', 'salaryMin': 180000})
        self.assertEqual(self.cli('preferences-get')['targetTitles'],
                         ['Existing Role', 'Staff ML Engineer'])
        status, _, conflict = self.request('PATCH', '/api/profile', patch)
        self.assertEqual(status, 409, conflict)
        self.assertEqual(self.cli('preferences-get')['targetTitles'],
                         ['Existing Role', 'Staff ML Engineer'])

    def test_unscored_selected_job_enters_companion_without_readiness_or_application(self):
        # The owner selected the second search result, despite incomplete salary facts.
        results = [
            {'url': 'https://example.com/jobs/newest', 'role': 'Newest', 'company': 'Example'},
            {'url': 'https://example.com/jobs/selected', 'role': 'Selected', 'company': 'Example'},
        ]
        selected = {'jobs': [results[1]]}
        preview = self.cli('job-upsert-preview', '--origin', 'agent', payload=selected)
        status, _, before = self.request('GET', '/api/state', origin=False)
        self.assertEqual((status, before['jobs']), (200, []))
        committed = self.cli(
            'job-upsert-commit', '--origin', 'agent', '--token', preview['token'],
            payload=selected,
        )
        self.assertTrue(committed['committed'])
        status, _, visible = self.request('GET', '/api/state', origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(len(visible['jobs']), 1)
        self.assertEqual(visible['jobs'][0]['role'], 'Selected')
        self.assertEqual(visible['jobs'][0]['status'], 'saved')
        self.assertNotIn('score', visible['jobs'][0])
        self.assertEqual(self.cli('preferences-get'), {})
