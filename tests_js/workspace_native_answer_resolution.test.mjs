import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pendingResolutionProjection, prepareAnswerResolution, sessionRevision } from '../runtime/contracts/workspace/answer-resolution.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const at = '2026-09-09T10:00:00Z';
const reference = `pending_${'a'.repeat(32)}`;
const other = `pending_${'b'.repeat(32)}`;
const plain = value => JSON.parse(serialize(value));
function fixture() {
  return {
    jobs: { jobs: { job: { id: 'job', status: 'needs_info', revision: 2 } } },
    answers: { schemaVersion: 1, answers: { answer: {
      key: 'answer', question: 'Preferred city?', state: 'confirmed', value: 'PRIVATE', revision: 3,
    } }, metadata: {}, redirects: {} },
    session: { schemaVersion: 1, applicationId: 'job', status: 'active', updatedAt: 'old',
      pendingFields: [{ question: 'Preferred city?', reference, answerKey: 'answer', state: 'missing' }],
      blockers: [{ type: 'information', code: 'answer-required', reference }] },
    input: { jobId: 'job', reference, expectedJobRevision: 2, expectedAnswerRevision: 3, ownerConfirmed: true, at, operationId: 'operation' },
    preflightReady: true,
  };
}
function native(item) {
  const jobs = fromJSON(item.jobs), answers = fromJSON(item.answers), session = fromJSON(item.session);
  const before = [jobs, answers, session].map(serialize);
  try {
    const prepared = prepareAnswerResolution(jobs, answers, session, {
      ...item.input,
      expectedJobRevision: BigInt(item.input.expectedJobRevision),
      expectedAnswerRevision: BigInt(item.input.expectedAnswerRevision),
      expectedSessionRevision: item.input.expectedSessionRevision === undefined ? sessionRevision(session) : BigInt(item.input.expectedSessionRevision),
    }, item.preflightReady);
    return { operation: plain(prepared.operation), result: plain(prepared.result) };
  } catch (error) { return { error: error.message }; }
  finally { assert.deepEqual([jobs, answers, session].map(serialize), before, 'preparation must not mutate inputs'); }
}
function python(fixtures) {
  const run = spawnSync('python3', ['-c', String.raw`
import json,sys,copy,hashlib,contextlib
from types import SimpleNamespace
sys.path.insert(0,'scripts')
import importlib.util
spec=importlib.util.spec_from_file_location('resolution_reference','scripts/job-apply-store.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
Store=module.Store
module.exclusive_file_lock=lambda path:contextlib.nullcontext()
module.uuid=SimpleNamespace(uuid4=lambda:'operation')
class Oracle(Store):
 def __init__(self,item): self.item=copy.deepcopy(item); self.store_lock_path=None
 def initialize(self): pass
 def _ensure_coordinator_files(self): pass
 def _require_job_unclaimed_locked(self,job): pass
 def _load_jobs_document(self): return self.item['jobs']
 def _load_answers_document(self): return self.item['answers']
 def _session_path(self,job): return SimpleNamespace(exists=lambda:True)
 def _read_session_projection(self,*args): return self.item['session']
 def _now(self): return self.item['input']['at']
 def _preflight_job_record(self,job): return {'ready':self.item['preflightReady']}
 def _commit_coordinator_operation_locked(self,operation):
  self.operation=operation
  job=self.item['jobs']['jobs'][operation['jobId']]
  job['revision']+=1
  job['status']=operation['targetStatus']
results=[]
for item in json.load(sys.stdin):
 oracle=Oracle(item)
 try:
  data=item['input']
  result=oracle.resolve_pending_answer(data['jobId'],data['reference'],data['expectedJobRevision'],
   data.get('expectedSessionRevision',oracle._session_revision(item['session'])),
   data['expectedAnswerRevision'],data['ownerConfirmed'])
  results.append({'operation':oracle.operation,'result':result})
 except Exception as error: results.append({'error':str(error)})
print(json.dumps(results))
`], { cwd: new URL('..', import.meta.url), input: JSON.stringify(fixtures), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('pending resolution matches Python transitions, revisions, redirects and denial boundaries', () => {
  const fixtures = [fixture()];
  const add = mutate => { const item = fixture(); mutate(item); fixtures.push(item); };
  add(x => { x.session.pendingFields.push({ reference: other, question: 'Other?', state: 'missing' }); x.preflightReady = false; });
  add(x => { x.session.blockers.push({ type: 'validation', code: 'validation-error-present' }); x.preflightReady = false; });
  for (const [state, reasonCode] of [['required', 'login-required'], ['ready_for_owner', 'final-review-required'], ['complete', 'none'], ['not_required', 'none']]) {
    add(x => { x.session.browserHandoff = { state, reasonCode, revision: 1 }; });
  }
  add(x => { x.preflightReady = false; });
  add(x => { x.answers.redirects.retired = { targetKey: 'answer', mergedAt: at }; x.session.pendingFields[0].answerKey = 'retired'; });
  add(x => { x.session.answerKeys = ['answer']; });
  add(x => { x.input.ownerConfirmed = false; });
  add(x => { x.input.reference = 'bad'; });
  add(x => { x.input.reference += '\n'; });
  add(x => { x.input.reference = other; });
  for (const field of ['expectedJobRevision', 'expectedAnswerRevision', 'expectedSessionRevision']) {
    add(x => { x.input[field] = 0; });
    add(x => { x.input[field] = 99; });
  }
  add(x => { x.jobs.jobs.job.deletedAt = at; });
  add(x => { x.jobs.jobs = {}; });
  add(x => { x.jobs.jobs.job.status = 'ready'; });
  add(x => { delete x.session.pendingFields[0].answerKey; });
  add(x => { x.session.pendingFields[0].sensitive = true; });
  add(x => { x.session.pendingFields[0].state = 'sensitive'; });
  add(x => { x.answers.answers.answer.deletedAt = at; });
  add(x => { x.answers.answers = {}; });
  add(x => { x.answers.answers.answer.state = 'inferred'; });
  add(x => { x.answers.answers.answer.reviewStatus = 'pending'; });
  add(x => { x.answers.answers.answer.value = null; });
  add(x => { x.answers.answers.answer.value = false; });
  add(x => { x.answers.answers.answer.sensitivity = 'personal'; });
  add(x => { x.session.pendingFields.push({ ...x.session.pendingFields[0] }); });
  add(x => { x.session.company = 'München 🚀'; x.session.step = '\ue000𐀀'; });
  assert.deepEqual(fixtures.map(native), python(fixtures));
});

test('pending projection is value-free and excludes missing, trashed or sensitive eligibility', () => {
  const item = fixture();
  const project = () => plain(pendingResolutionProjection(fromJSON(item.session.pendingFields[0]), fromJSON(item.answers)));
  assert.deepEqual(project(), { reference, answerRevision: 3, answerKey: 'answer', answerSensitivity: 'none', resolutionEligible: true });
  item.answers.answers.answer.sensitivity = 'high';
  assert.equal(project().resolutionEligible, false);
  assert.ok(!JSON.stringify(project()).includes('PRIVATE'));
  item.answers.answers.answer.deletedAt = at;
  assert.deepEqual(project(), { reference, resolutionEligible: false });
  delete item.session.pendingFields[0].answerKey;
  assert.deepEqual(project(), { reference, resolutionEligible: false });
});

test('resolution rejects boolean, fractional and absent revision tokens', () => {
  const item = fixture();
  const args = { ...item.input, expectedJobRevision: 2n, expectedAnswerRevision: 3n,
    expectedSessionRevision: sessionRevision(fromJSON(item.session)) };
  for (const name of ['expectedJobRevision', 'expectedSessionRevision', 'expectedAnswerRevision']) {
    for (const invalid of [true, 1.5, undefined, null, '2']) {
      assert.throws(() => prepareAnswerResolution(fromJSON(item.jobs), fromJSON(item.answers), fromJSON(item.session),
        { ...args, [name]: invalid }, true), /answer resolution revision is invalid/);
    }
  }
});
