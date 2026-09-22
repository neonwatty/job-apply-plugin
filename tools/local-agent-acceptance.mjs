#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute=promisify(execFile),repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixtureRoot=join(repository,'.workflows','fixtures','job-apply.synthetic-application-automation-v1');
const localRoot=join(repository,'.workflows','local');
if(process.env.CI)throw Error('live application-agent acceptance is local-only and cannot run in CI');
let trials=3,keep=false,model='gpt-5.6-luna';
for(let index=2;index<process.argv.length;index++){
  if(process.argv[index]==='--trials'){trials=Number(process.argv[++index]);continue;}
  if(process.argv[index]==='--model'){model=process.argv[++index];continue;}
  if(process.argv[index]==='--keep'){keep=true;continue;}throw Error('Usage: npm run test:agent-local -- [--trials 1..10] [--model MODEL] [--keep]');
}
if(!Number.isSafeInteger(trials)||trials<1||trials>10||!model)throw Error('trials must be an integer from 1 to 10 and model must be non-empty');
await execute('codex',['--version'],{cwd:repository,timeout:10_000});await mkdir(localRoot,{recursive:true,mode:0o700});

async function sourceFingerprint(){
  const [diff,untracked]=await Promise.all([
    execute('git',['diff','--binary','--no-ext-diff','HEAD','--','.'],{cwd:repository,maxBuffer:16*1024*1024}),
    execute('git',['ls-files','--others','--exclude-standard'],{cwd:repository,maxBuffer:4*1024*1024}),
  ]);
  return createHash('sha256').update(diff.stdout).update('\0').update(untracked.stdout).digest('hex');
}
async function run(command,args,options={}){
  const result=await execute(command,args,{cwd:repository,maxBuffer:8*1024*1024,timeout:options.timeout??120_000,
    env:{...process.env,NO_COLOR:'1'}});
  if(result.stderr)process.stderr.write(result.stderr);return result.stdout;
}
async function runAgent(args){
  await new Promise((resolve,reject)=>{
    const child=spawn('codex',args,{cwd:repository,env:{...process.env,NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(Error('live agent timed out after 6 minutes'));},360_000);
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>8*1024*1024)child.kill('SIGTERM');});
    child.stderr.on('data',chunk=>{stderr+=chunk;process.stderr.write(chunk);if(stderr.length>8*1024*1024)child.kill('SIGTERM');});
    child.once('error',finish);child.once('exit',(code,signal)=>finish(code===0?null:Error(`live agent failed (${signal??code})`)));
    child.stdin.end();
  });
}
async function stopBroker(storeRoot){
  if(!storeRoot)return;
  try{const pid=Number((await readFile(join(storeRoot,'.job-apply-attempt.pid'),'utf8')).trim());if(Number.isSafeInteger(pid)&&pid>1)process.kill(pid,'SIGTERM');}
  catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
}

const receipts=[],before=await sourceFingerprint();
for(let trial=1;trial<=trials;trial++){
  const journeyRoot=join(localRoot,`application-automation-${Date.now()}-${randomUUID()}`);
  let passed=false,storeRoot=null;
  try{
    const prepared=JSON.parse(await run(process.execPath,[join(fixtureRoot,'prepare.mjs'),'--journey-root',journeyRoot]));
    storeRoot=prepared.storeRoot;
    const acquired=JSON.parse(await run(process.execPath,[join(repository,'runtime/cli/native-attempt.js'),'--root',storeRoot,
      'start','--id',prepared.jobId,'--owner','Synthetic local acceptance','--expected-revision',String(prepared.readyRevision)]));
    if(acquired.ok!==true||acquired.event!=='acquired')throw Error('fixture attempt broker did not acquire the exact synthetic job');
    const resultPath=join(journeyRoot,'agent-result.json'),decisionPath=join(journeyRoot,'decision.json');
    const prompt=`Run the committed synthetic local application-automation acceptance fixture. This is execution, not code work and not an Agent Workflows runner task; follow only the direct protocol below.\n\n`
      +`Hard boundaries: do not edit repository files; do not use a browser, network, web search, real applicant data, real accounts, or any host except example.invalid. Use only the paths below. Never invoke the portal submit command. Stop at final review.\n\n`
      +`Current owner approval: I approve Campaign to Review for this exact synthetic job for 120 minutes, with no sensitive answer references, always stopping at final review. This approval applies only to the activation packet below.\n\n`
      +`Journey root: ${journeyRoot}\nStore root: ${prepared.storeRoot}\nJob ID: ${prepared.jobId}\nReady revision: ${prepared.readyRevision}\nPortal helper: ${prepared.portal}\n\n`
      +`The harness has already acquired the exact synthetic job through its detached broker. Perform exactly this protocol:\n`
      +`1. Inspect saved setup with: node runtime/cli/native-jobs.js --root "${prepared.storeRoot}" profile-inspect. Require profile.applicationPreferences.preferredAutomationMode to be campaign_to_review. Treat it only as a preference, not authority.\n`
      +`2. Read live authority with: node runtime/cli/native-jobs.js --root "${prepared.storeRoot}" application-authority-status. Require mode guided and revision 0.\n`
      +`3. Activate the approved exact scope once with: node runtime/cli/native-jobs.js --root "${prepared.storeRoot}" application-authority-set --input "${join(journeyRoot,'activation.json')}" --expected-revision 0. Require mode campaign_to_review, only Job ID ${prepared.jobId}, a future expiration, and no sensitive answer references.\n`
      +`4. Inspect the portal with: node "${prepared.portal}" --command inspect --journey-root "${journeyRoot}".\n`
      +`5. Evaluate authority exactly once and save its stdout: node runtime/cli/native-attempt.js --root "${prepared.storeRoot}" authority-evaluate --input "${join(journeyRoot,'evaluation.json')}" > "${decisionPath}". Require the response envelope to have ok true and event authority_evaluated, with decision.authorized true and decision.mode campaign_to_review.\n`
      +`6. In this exact order, run the portal helper with --command apply --journey-root "${journeyRoot}" --decision "${decisionPath}" --operation OPERATION for: fill_canonical_profile, upload_managed_resume, fill_confirmed_answer, navigate_non_final.\n`
      +`7. Inspect again. Require stage final_review and finalAction.activated false. Do not activate it.\n`
      +`8. Commit the manual-review handoff: node runtime/cli/native-attempt.js --root "${prepared.storeRoot}" handoff --status awaiting_review --input "${join(journeyRoot,'handoff.json')}".\n`
      +`9. Return only the JSON object required by the output schema. Set outcome passed only if every command succeeded and the final action remained untouched. Set authorityActivations to 1 and authorityEvaluations to 1.`;
    await runAgent(['exec','--ephemeral','--ignore-user-config','--ignore-rules','--disable','skill_search',
      '--sandbox','danger-full-access','--model',model,
      '--config','approval_policy="never"','--color','never','-C',repository,'--output-schema',join(fixtureRoot,'result.schema.json'),
      '--output-last-message',resultPath,prompt]);
    const receipt=JSON.parse(await run(process.execPath,[join(fixtureRoot,'evaluate.mjs'),'--journey-root',journeyRoot]));
    if(await sourceFingerprint()!==before)throw Error('live agent changed repository source state');
    receipts.push({trial,...receipt});passed=true;
  }finally{
    await stopBroker(storeRoot);
    if(passed&&!keep)await rm(journeyRoot,{recursive:true,force:false});
    else if(!passed)process.stderr.write(`Preserved failed local journey: ${journeyRoot}\n`);
  }
}
process.stdout.write(`${JSON.stringify({ok:true,trials:receipts.length,receipts})}\n`);
