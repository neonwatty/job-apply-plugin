import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setup as baseSetup, plain, read, write, snapshot } from './workspace_native_claims_support.mjs';
import { AnswerLifecycleService } from '../runtime/workspace-core/answer-lifecycle.js';
export { plain, read, write, snapshot };
export const at = '2026-09-10T15:00:00Z';
export async function setup(fixture, name, extra = {}) {
  const state = await baseSetup(fixture, name);
  await write(state.root, 'answers.json', {schemaVersion:1, redirects:{}, metadata:{updatedAt:at},
    answers:{answer:{key:'answer', question:'Preferred editor?', state:'confirmed', value:'synthetic answer', updatedAt:at}}, ...extra});
  return {...state, service:new AnswerLifecycleService(state.repository, () => at)};
}
const python = `import importlib.util,json,sys
from pathlib import Path
sys.path.insert(0,str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('lifecycle_reference','scripts/job-apply-store.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.utc_now=lambda:'2026-09-10T15:00:00Z'
store=module.Store(Path(sys.argv[1])); store.initialize()
results=[]
for op in json.loads(sys.argv[2]):
 try: result={'value':getattr(store,op['kind']+'_answer')(op.get('key','answer'),op['revision'])}
 except module.StoreError as error: result={'error':str(error)}
 result['answers']=json.loads(store.answers_path.read_text())
 results.append(result)
print(json.dumps(results))`;
export async function differential(state, target, operations) {
  await cp(state.root, target, {recursive:true});
  const reference = JSON.parse((await promisify(execFile)('python3', ['-c',python,target,JSON.stringify(operations)], {maxBuffer:8*1024*1024})).stdout);
  for (const [index, op] of operations.entries()) {
    const before = await snapshot(state.root);
    let actual;
    try { actual = {value:plain(await state.service[op.kind](op.key ?? 'answer', BigInt(op.revision)))}; }
    catch (error) { actual = {error:error.message}; }
    const {answers, ...expected} = reference[index];
    assert.deepEqual(actual, expected, `operation ${index}: ${JSON.stringify(op)}`);
    assert.deepEqual(await read(state.root, 'answers.json'), answers);
    const after = await snapshot(state.root);
    if (actual.error) assert.deepEqual(after, before);
    delete before['answers.json']; delete after['answers.json'];
    assert.deepEqual(after, before, 'only answers.json may change');
  }
}
