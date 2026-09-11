import assert from 'node:assert/strict';
import { cp } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setup as claimsSetup, plain, read, write, snapshot, cli } from './workspace_native_claims_support.mjs';
import { TrashService } from '../runtime/workspace-core/trash.js';
export { plain, read, write, snapshot, cli };
export const at = '2026-09-10T15:00:00Z';
export async function setup(fixture,name) {
  const state=await claimsSetup(fixture,name);
  return {...state,service:new TrashService(state.repository,()=>at)};
}
const python = `import importlib.util,json,sys
from pathlib import Path
sys.path.insert(0,str(Path('scripts').resolve()))
spec=importlib.util.spec_from_file_location('trash_reference','scripts/job-apply-store.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.utc_now=lambda:'2026-09-10T15:00:00Z'
from job_apply_workspace.projections import unified_trash_projection
store=module.Store(Path(sys.argv[1])); store.initialize()
results=[]
for op in json.loads(sys.argv[2]):
 try:
  value=unified_trash_projection(store) if op['kind']=='list' else getattr(store,op['kind']+'_job')(op.get('id','job'),op['revision'])
  result={'value':value}
 except module.StoreError as error: result={'error':str(error)}
 result['jobs']=json.loads(store.jobs_path.read_text())
 results.append(result)
print(json.dumps(results))`;
export async function differential(state,target,operations) {
  await cp(state.root,target,{recursive:true});
  const reference=JSON.parse((await promisify(execFile)('python3',['-c',python,target,JSON.stringify(operations)],{maxBuffer:8*1024*1024})).stdout);
  for(const [index,op] of operations.entries()) {
    const before=await snapshot(state.root);
    let actual;
    try {actual={value:plain(await (op.kind==='list'?state.service.list():state.service[`${op.kind}Job`](op.id??'job',BigInt(op.revision))))};}
    catch(error) {actual={error:error.message};}
    const {jobs,...expected}=reference[index];
    assert.deepEqual(actual,expected,`operation ${index}: ${JSON.stringify(op)}`);
    assert.deepEqual(await read(state.root,'jobs.json'),jobs);
    const after=await snapshot(state.root);
    if(op.kind==='list'||actual.error) assert.deepEqual(after,before);
    delete before['jobs.json']; delete after['jobs.json'];
    assert.deepEqual(after,before,'only jobs.json may change');
  }
}
export async function unchanged(state,operation,pattern) {
  const before=await snapshot(state.root);
  await assert.rejects(operation,pattern);
  assert.deepEqual(await snapshot(state.root),before);
}
