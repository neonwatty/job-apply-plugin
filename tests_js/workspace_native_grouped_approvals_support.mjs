import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setup as claimsSetup, plain, read, write, snapshot } from './workspace_native_claims_support.mjs';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { GroupedApprovalsService } from '../runtime/workspace-core/grouped-approvals.js';
import { sessionRevision } from '../runtime/contracts/workspace/answer-resolution.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';
export { plain, read, write, snapshot };
export const at = '2026-09-10T14:00:00Z';
export async function setup(fixture, name, { claimed = false } = {}) {
  const state = await claimsSetup(fixture, name);
  const answers = new AnswersService(state.repository, () => at);
  for (const key of ['first', 'second', 'third']) {
    await answers.put(fromJSON({key, question:`Stored ${key} field?`, state:'confirmed', value:`PRIVATE-ANSWER-${key}`,
      scope:{ats:'greenhouse'}, fieldClass:'authorization'}));
  }
  await state.claims.select('job', 1n, true);
  const acquired = plain(await state.claims.acquire('job', text('Fixture owner'), 2n));
  const packet = {status:'active', pendingFields:['first','second','third'].map(key => ({question:`Stored ${key} field?`,
    state:'missing', answerKey:key, sensitive:false, fieldClass:'authorization', scope:{ats:'greenhouse'}}))};
  if (claimed) await state.claims.progress('job', text(acquired.token), fromJSON(packet));
  else await state.claims.handoff('job', text(acquired.token), 'needs_info', fromJSON(packet), 3n);
  const session = await read(state.root, 'sessions/job.json');
  const decisions = session.pendingFields.map(field => ({reference:field.reference, answerKey:field.answerKey,
    currentUse:true, remember:false, policyMode:'strict', useAuthority:'accepted_record', allowedSensitiveFieldClasses:[]}));
  return {...state, answers, decisions, service:new GroupedApprovalsService(state.repository, () => at)};
}
export async function revisions(state) {
  return [BigInt((await read(state.root, 'jobs.json')).jobs.job.revision),
    sessionRevision(fromJSON(await read(state.root, 'sessions/job.json')))];
}
export async function preview(state, decisions = state.decisions) {
  return plain(await state.service.preview('job', ...await revisions(state), fromJSON(decisions)));
}
export async function unchanged(root, operation, pattern) {
  const before = await snapshot(root);
  await assert.rejects(operation, pattern);
  assert.deepEqual(await snapshot(root), before);
}
const python = `import importlib.util,json,sys
from pathlib import Path
from datetime import datetime,timezone
sys.path.insert(0,str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('approval_reference','scripts/job-apply-store.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.utc_now=lambda:'2026-09-10T14:00:00Z'
store=module.Store(Path(sys.argv[1]),clock=lambda:datetime(2026,9,10,14,tzinfo=timezone.utc))
store.initialize()
results=[]
for operation in json.loads(sys.argv[2]):
    session=store._read_session_projection(store._session_path('job'),'job','greenhouse')
    job_revision=store._load_jobs_document()['jobs']['job']['revision']
    session_revision=store._session_revision(session)
    try:
        args=('job',operation.get('jobRevision',job_revision),operation.get('sessionRevision',session_revision),operation['decisions'])
        preview=store.preview_grouped_approval(*args)
        result=store.approve_grouped_approval(*args,operation.get('token',preview['previewToken']),owner_confirmed=operation.get('confirmed',True)) if operation.get('approve') else preview
        record={'result':result}
    except module.StoreError as error:
        record={'error':str(error)}
    record['session']=json.loads(store._session_path('job').read_text())
    results.append(record)
print(json.dumps(results))`;
export async function differential(state, target, operations) {
  await cp(state.root, target, {recursive:true, preserveTimestamps:true});
  const expected = JSON.parse((await promisify(execFile)('python3', ['-c', python, target, JSON.stringify(operations)],
    {maxBuffer:8*1024*1024})).stdout);
  for (const [index, operation] of operations.entries()) {
    const before = await snapshot(state.root);
    const revs = await revisions(state);
    const args = ['job', BigInt(operation.jobRevision ?? revs[0]), BigInt(operation.sessionRevision ?? revs[1]), fromJSON(operation.decisions)];
    let actual;
    try {
      const projected = plain(await state.service.preview(...args));
      actual = {result:operation.approve ? plain(await state.service.approve(...args, operation.token ?? projected.previewToken, operation.confirmed ?? true)) : projected};
    } catch (error) { actual = {error:error.message}; }
    const {session, ...result} = expected[index];
    assert.deepEqual(actual, result, `operation ${index}`);
    assert.deepEqual(await read(state.root, 'sessions/job.json'), session, `persisted session ${index}`);
    const after = await snapshot(state.root);
    if (actual.error || !operation.approve) assert.deepEqual(after, before);
    delete before['sessions/job.json']; delete after['sessions/job.json'];
    assert.deepEqual(after, before, 'grouped approval changes only its session');
    assert.doesNotMatch(JSON.stringify(actual), /PRIVATE-|tokenHash|resume\.txt/);
  }
}
