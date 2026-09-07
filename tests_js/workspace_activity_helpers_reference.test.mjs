import assert from 'node:assert/strict';
import test from 'node:test';
import * as h from '../workspace/lib/helpers.js';

test('activity reference: job filter preserves identity/order and status short circuit', () => {
  const first = Object.freeze({ role: 'Engineer', company: 'Synthetic', status: 'saved' });
  const second = Object.freeze({ role: 'Engineer', status: 'closed' });
  const jobs = Object.freeze([first, second]);
  assert.deepEqual(h.filterJobs(jobs, ' ENGINE ', 'saved'), [first]);
  assert.equal(h.filterJobs(jobs)[0], first);
  assert.notEqual(h.filterJobs(jobs), jobs);
  assert.deepEqual(h.filterJobs([{ status: 'closed', get role() { throw Error('unused'); } }], 'x', 'saved'), []);
  assert.deepEqual(h.filterJobs([{ role: 123 }], '23'), [{ role: 123 }]);
  assert.throws(() => h.filterJobs(null), TypeError);
  assert.throws(() => h.filterJobs(jobs, null), TypeError);
});

test('activity reference: transition and readiness maps preserve inherited lookup behavior', () => {
  const transitions = { saved: ['needs_info', 'closed'], needs_info: ['saved', 'closed'], ready: ['saved', 'needs_info', 'closed'],
    in_progress: [], awaiting_review: ['applied', 'closed'], applied: ['closed'], closed: ['saved'] };
  for (const [status, expected] of Object.entries(transitions)) assert.deepEqual(h.transitionsFor(status), expected);
  assert.deepEqual(h.transitionsFor('unknown'), []);
  assert.equal(h.transitionsFor('toString'), Object.prototype.toString);
  assert.equal(h.transitionsFor('__proto__'), Object.prototype);
  assert.notEqual(h.transitionsFor('saved'), h.transitionsFor('saved'));
  assert.equal(h.canMarkReadyFrom('saved'), true);
  assert.equal(h.canMarkReadyFrom('needs_info'), true);
  assert.equal(h.canMarkReadyFrom('ready'), false);
});

test('activity reference: revision policies retain integer checks, ties and reference returns', () => {
  assert.equal(h.shouldUseActivityResponse({ job: { revision: 2 } }, { revision: 1 }, { revision: '99' }), true);
  assert.equal(h.shouldUseActivityResponse({ job: { revision: 2 } }, { revision: 3 }), false);
  assert.equal(h.shouldUseActivityResponse({ job: { revision: -1 } }), false);
  assert.equal(h.shouldUseActivityResponse({ job: { revision: 1.5 } }), false);
  const current = Object.freeze({ id: 'a', revision: 2 });
  const incoming = Object.freeze({ id: 'a', revision: 2 });
  assert.equal(h.newestCanonicalJob(current, incoming), incoming);
  assert.equal(h.newestCanonicalJob(current, { id: 'b', revision: 99 }), current);
  assert.equal(h.newestCanonicalJob(current, { id: 'a', revision: 1 }), current);
  assert.equal(h.newestCanonicalJob(null, incoming), incoming);
  assert.equal(h.newestCanonicalJob({}, incoming).id, undefined);
});

test('activity reference: signatures and announcements preserve field selection and ordered copy', () => {
  assert.equal(h.activitySignature(null), '');
  assert.equal(h.activitySignature({}), '{"pendingInformation":[],"history":[]}');
  assert.equal(h.activitySignature({ ignored: 1 }), h.activitySignature({ ignored: 2 }));
  const before = { job: { status: 'saved' }, history: [] };
  const after = { job: { status: 'needs_info' }, claim: { state: 'active' }, session: { updatedAt: 'now', step: 'review' }, history: [{}] };
  assert.equal(h.activityAnnouncement(before, after), 'Status changed to needs info. Agent attempt is active. Progress updated at review. Application history updated.');
  assert.equal(h.activityAnnouncement(null, after), '');
  assert.equal(h.activityAnnouncement(before, { ...before, job: { status: 'saved', revision: 2 } }), '');
  assert.throws(() => h.activityAnnouncement(before, null), TypeError);
  assert.throws(() => h.activitySignature({ history: [1n] }), TypeError);
});

test('activity reference: attention signatures preserve order and blocker special-case exactness', () => {
  assert.equal(h.attentionMembershipSignature(null), '[]');
  assert.equal(h.attentionMembershipSignature({ items: [{ jobId: 'j', reasonCode: 'x', ignored: 1 }] }), '[["j","x"]]');
  assert.equal(h.attentionMembershipSignature({ items: [{}] }), '[[null,null]]');
  assert.throws(() => h.attentionMembershipSignature({ items: [null] }), TypeError);
  assert.equal(h.attentionAnnouncement({ items: [] }, { items: [{}] }), 'Needs Attention queue updated. 1 job now require action.');
  assert.equal(h.attentionAnnouncement({ items: [{}] }, null), 'Needs Attention queue updated. 0 jobs now require action.');
  assert.equal(h.attentionMissingInformationText({ reasonCode: 'needs_information', missingInformationCount: -2 }), ' · -2 missing information items');
  assert.equal(h.attentionMissingInformationText({ reasonCode: 'needs_information', missingInformationCount: '1' }), ' · 0 missing information items');
  assert.equal(h.attentionMissingInformationText(null), '');
  const blockers = [{ type: 'browser_handoff', code: 'unsupported-control' }, { type: 'information', code: 'owner-input-required' }];
  assert.equal(h.attentionBlockerSummary({ reasonCode: 'browser_action_required', session: { blockers } }), 'Browser action required: unsupported control. Saved information is already known.');
  assert.equal(h.attentionBlockerSummary({ session: { blockers } }), '2 typed blockers: unsupported-control, owner-input-required');
  assert.equal(h.attentionBlockerSummary(null), 'No typed blockers recorded.');
  assert.throws(() => h.attentionBlockerSummary({ session: { blockers: [null] } }), TypeError);
});

test('activity reference: owner next-step copy and prototype lookups remain observable', () => {
  const labels = {
    import_resume: ['Import a resume', 'Add a private managed resume so agents have an approved document to use.'],
    review_facts: ['Review your application facts', 'Confirm the local facts agents may use before you prepare a job.'],
    resolve_attention: ['Resolve Needs Attention', 'A job needs human review, missing information, or interrupted-work recovery.'],
    handoff_ready_job: ['Hand off a ready job', 'Copy the supported invocation below and let the agent acquire the canonical Ready job.'],
    capture_job: ['Capture your first job', 'Save an opportunity, run its ready check, and mark it Ready for an agent.'],
    prepare_job: ['Prepare the next job', 'Open Jobs, complete missing setup, run the ready check, and mark a job Ready.'],
  };
  for (const [action, expected] of Object.entries(labels)) assert.deepEqual(h.ownerBetaNextStep(action), expected);
  assert.deepEqual(h.ownerBetaNextStep('unknown'), ['Review the workspace', 'Refresh the canonical Store and choose a workspace section.']);
  assert.equal(h.ownerBetaNextStep('toString'), Object.prototype.toString);
  assert.notEqual(h.ownerBetaNextStep('import_resume'), h.ownerBetaNextStep('import_resume'));
});
