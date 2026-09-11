import assert from 'node:assert/strict';
import { cp, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { parse } from '../runtime/contracts/workspace/values.js';
import { canonicalJson } from '../runtime/contracts/workspace/canonical-json.js';
import { plain, snapshot } from './workspace_native_claims_support.mjs';
export { fixed, item, unchanged } from './workspace_native_job_upsert_support.mjs';
export async function differential(service, root, referenceRoot, operations) {
  await cp(root,referenceRoot,{recursive:true,preserveTimestamps:true});
  const reference = JSON.parse((await promisify(execFile)('python3',[
    'tools/contracts/task-intake/reference.py',referenceRoot,JSON.stringify(operations),
  ],{maxBuffer:8*1024*1024})).stdout);
  for(const [index,operation] of operations.entries()) {
    const before = await snapshot(root);
    let actual;
    try {
      actual = {result:plain(await service.intake(parse(operation.payloadJson ?? JSON.stringify(operation.payload)),operation.origin))};
    } catch(error) { actual = {error:error.message}; }
    const {document,...expected} = reference[index];
    assert.deepEqual(actual,expected,`intake operation ${index}: ${JSON.stringify(operation)}`);
    assert.equal(canonicalJson(parse(await readFile(join(root,'jobs.json'),'utf8'))),canonicalJson(parse(document)));
    const after = await snapshot(root);
    if(actual.error || actual.result.action==='noop') assert.deepEqual(after,before,'rejection and noop preserve canonical bytes');
    delete before['jobs.json']; delete after['jobs.json'];
    assert.deepEqual(after,before,'intake changes only jobs.json');
  }
}
export function stdin(fixture,root,payload,args=[]) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,['runtime/cli/native-jobs.js','--root',root,'--native-lock',fixture.receipt.artifact,
      'task-intake','--input','-',...args],{cwd:new URL('../',import.meta.url),env:{PATH:''}});
    let stdout='',stderr='';
    child.stdout.on('data',bytes=>{stdout+=bytes;});
    child.stderr.on('data',bytes=>{stderr+=bytes;});
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0 || stderr) return reject(Error(stderr || `exit ${code}`));
      try {resolve(JSON.parse(stdout));} catch(error){reject(error);}
    });
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(payload));
  });
}
