import { mkdtemp, chmod, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeWorkflowArchive } from '../runtime/store/native-workflow-archive.js';
import { emptyWorkflowLedger } from '../runtime/contracts/workspace/workflow-tasks.js';
export const hash = 'a'.repeat(64);
export function task(id,revision='1',status='cancelled') {
  return {taskId:id,workflow:{id:'applications.prepare',version:1},revision,
    subject:{jobId:'job',jobRevision:'1',inputRevision:hash},status,
    pending:status==='waiting'?{requestId:'request',questionId:'question'}:null};
}
export function fullLedger(archive,idPrefix='task') {
  const ledger=archive.migrate(emptyWorkflowLedger());
  for(let index=0;index<63;index++) {
    const current=task(`${idPrefix}-${index}`);
    ledger.tasks[current.taskId]=current;
    ledger.receipts[`op-${idPrefix}-${index}`]={fingerprint:hash,receipt:{operationId:`op-${idPrefix}-${index}`,task:current,outcome:'cancelled'}};
  }
  return ledger;
}
export async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'workflow-archive-'));
  await chmod(root,0o700);t.after(()=>rm(root,{recursive:true,force:true}));
  const archive=new NativeWorkflowArchive(root);
  let ledger=archive.migrate(emptyWorkflowLedger());
  const save=async next=>{ledger=structuredClone(next);await writeFile(join(root,'hot.json'),JSON.stringify(ledger),{mode:0o600});};
  await save(ledger);
  const store={transaction:async operation=>{
    const prepared=await new NativeWorkflowArchive(root).prepare(ledger);
    return operation({...prepared,domain:{},commit:async next=>{await prepared.flush();await save(next);}});
  }};
  return {root,archive,store,save,ledger:()=>structuredClone(ledger),read:()=>readFile(join(root,'hot.json'),'utf8')};
}
