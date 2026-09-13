"""UI-free onboarding and conservative resume selection contracts."""
from tests.support.store_case import StoreTestCase, STORE_MODULE


class AgentOnboardingTests(StoreTestCase):
    def resume(self, name='sole', default=False):
        return self.store.create_resume_bytes(
            {'id': name, 'label': name, 'default': default}, 'resume.txt', ('Synthetic resume ' + name).encode())

    def profile_and_job(self, **fields):
        self.store.replace_profile({'firstName': 'Synthetic'},
                                   self.store.inspect_profile()['revision'], source='user')
        return self.store.create_job({'url': 'https://example.invalid/role', **fields})

    def test_sole_nondefault_is_used_without_persisting_assignment(self):
        resume = self.resume()
        job = self.profile_and_job()
        before_jobs = self.store.jobs_path.read_bytes()
        before_resumes = self.store.resumes_path.read_bytes()
        result = self.store.preflight_job(job['id'])
        self.assertTrue(result['ready'])
        self.assertEqual(result['resumeId'], resume['id'])
        preparedness = self.store.profile_preparedness()
        resume_state = next(item for item in preparedness['essentialSetup'] if item['id'] == 'default_resume')
        self.assertEqual(resume_state['state'], 'present')
        self.assertEqual(self.store.jobs_path.read_bytes(), before_jobs)
        self.assertEqual(self.store.resumes_path.read_bytes(), before_resumes)
        ready = self.store.transition_job(job['id'], 'ready', job['revision'])
        acquired = self.store.acquire_ready_job(job['id'], 'synthetic-test', ready['revision'])
        self.assertEqual(acquired['resume']['id'], resume['id'])

    def test_multiple_active_without_default_need_owner_selection(self):
        self.resume('one')
        self.resume('two')
        job = self.profile_and_job()
        result = self.store.preflight_job(job['id'])
        self.assertFalse(result['ready'])
        self.assertIsNone(result['resumeId'])
        self.assertIn('resume_missing', result['errors'])
        self.assertEqual(self.store.get_job(job['id'])['status'], 'saved')

    def test_broken_default_is_not_replaced_by_other_resume(self):
        selected = self.resume('default', default=True)
        self.resume('alternative')
        (self.store.resume_files_path / selected['managedFile']).unlink()
        job = self.profile_and_job()
        result = self.store.preflight_job(job['id'])
        self.assertEqual(result['resumeId'], selected['id'])
        self.assertIn('resume_file_missing', result['errors'])

    def test_broken_assignment_is_not_replaced_by_default(self):
        self.resume('default', default=True)
        assigned = self.resume('assigned')
        job = self.profile_and_job(resumeId=assigned['id'])
        (self.store.resume_files_path / assigned['managedFile']).write_bytes(b'tampered')
        result = self.store.preflight_job(job['id'])
        self.assertEqual(result['resumeId'], assigned['id'])
        self.assertIn('resume_file_changed', result['errors'])
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.transition_job(job['id'], 'ready', job['revision'])

    def test_trashed_resume_does_not_make_sole_active_ambiguous(self):
        removed = self.resume('removed')
        self.store.trash_resume(removed['id'], removed['revision'])
        remaining = self.resume('active')
        job = self.profile_and_job()
        self.assertEqual(self.store.preflight_job(job['id'])['resumeId'], remaining['id'])

    def test_extraction_intake_replenishment_and_checks_need_no_ui(self):
        resume = self.resume()
        request = self.store.create_resume_extraction_request(resume['id'], resume['revision'])
        # Prepared synthetic facts validate persistence, not semantic resume extraction.
        completed = self.store.complete_resume_extraction_request(
            request['requestId'], {'firstName': 'Synthetic', 'email': 'test@example.invalid'},
            request['revision'], self.store.inspect_profile()['revision'])
        self.assertEqual(completed['request']['status'], 'completed')
        payload = {'jobs': [{'url': 'https://example.invalid/intake', 'role': 'Engineer'}]}
        preview = self.store.preview_job_upsert(payload, 'agent')
        saved = self.store.commit_job_upsert(payload, 'agent', preview['token'])
        job_id = saved['decisions'][0]['id']
        self.assertTrue(self.store.preflight_job(job_id)['ready'])
        self.assertEqual(self.store.get_job(job_id)['status'], 'saved')
        repeated = self.store.preview_job_upsert(payload, 'agent')
        result = self.store.commit_job_upsert(payload, 'agent', repeated['token'])
        self.assertEqual(result['summary']['noop'], 1)
        self.assertEqual(len(self.store.list_jobs()), 1)
        self.assertTrue(self.store.preflight_job(job_id)['ready'])
        self.assertEqual(self.store.get_job(job_id)['status'], 'saved')
