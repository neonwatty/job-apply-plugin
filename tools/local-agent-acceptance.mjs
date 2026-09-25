#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute=promisify(execFile),repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
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
    execute('git',['ls-files','--others','--exclude-standard','-z'],{cwd:repository,maxBuffer:4*1024*1024,encoding:'buffer'}),
  ]);
  const hash=createHash('sha256').update(diff.stdout).update('\0');
  for(const bytes of untracked.stdout.subarray(0,-1).toString('utf8').split('\0').filter(Boolean)){
    hash.update(bytes).update('\0').update(await readFile(join(repository,bytes))).update('\0');
  }
  return hash.digest('hex');
}
async function run(command,args,options={}){
  const result=await execute(command,args,{cwd:repository,maxBuffer:8*1024*1024,timeout:options.timeout??120_000,
    env:{...process.env,...options.env,NO_COLOR:'1'}});
  if(result.stderr)process.stderr.write(result.stderr);return result.stdout;
}
async function runAgent(args,env){
  await new Promise((resolve,reject)=>{
    const child=spawn('codex',args,{cwd:repository,env:{...process.env,...env,NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(Error('live agent timed out after 6 minutes'));},360_000);
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>8*1024*1024)child.kill('SIGTERM');});
    child.stderr.on('data',chunk=>{stderr+=chunk;process.stderr.write(chunk);if(stderr.length>8*1024*1024)child.kill('SIGTERM');});
    child.once('error',finish);child.once('exit',(code,signal)=>finish(code===0?null:Error(`live agent failed (${signal??code})`)));
    child.stdin.end();
  });
}

async function installLocalPlugin(){
  const temporary=await mkdtemp(join(tmpdir(),'job-apply-agent-package-'));
  try{
    const fixture=join(temporary,'marketplace'),archive=join(temporary,'marketplace.tar'),codexHome=join(temporary,'codex-home');
    await mkdir(fixture,{mode:0o700});await mkdir(codexHome,{mode:0o700});
    const hostCodexHome=resolve(process.env.CODEX_HOME??join(homedir(),'.codex'));
    await symlink(join(hostCodexHome,'auth.json'),join(codexHome,'auth.json'));
    await run('tar',['--exclude=./.git','--exclude=./.qa-private','--exclude=./qa/runs','--exclude=./.job-apply-qa',
      '--exclude=./node_modules','--exclude=./.workflows/local','--exclude=./docs/goals','--exclude=./test_resumes',
      '--exclude=./coverage','--exclude=./dist','--exclude=./build','--exclude=./apps/companion/.next',
      '--exclude=./.worktrees','--exclude=__pycache__','--exclude=*.py[co]','-cf',archive,'-C',repository,'.']);
    await run('tar',['-xf',archive,'-C',fixture]);
    await run('python3',[join(repository,'scripts/smoke/fixture_build.py'),'rewrite-marketplace',join(fixture,'.claude-plugin/marketplace.json')]);
    const env={CODEX_HOME:codexHome};
    await run('codex',['plugin','marketplace','add',fixture,'--json'],{env});
    await run('codex',['plugin','add','job-apply@neonwatty-plugins','--json'],{env});
    const version=JSON.parse(await readFile(join(fixture,'.codex-plugin/plugin.json'),'utf8')).version;
    const installedRoot=await realpath(join(codexHome,'plugins','cache','neonwatty-plugins','job-apply',version));
    return {temporary,codexHome,installedRoot};
  }catch(error){
    try{await rm(temporary,{recursive:true,force:true});}
    catch(cleanupError){throw new AggregateError([error,cleanupError],'plugin installation and temporary cleanup failed');}
    throw error;
  }
}
async function stopBroker(storeRoot){
  if(!storeRoot)return;
  try{const pid=Number((await readFile(join(storeRoot,'.job-apply-attempt.pid'),'utf8')).trim());if(Number.isSafeInteger(pid)&&pid>1)process.kill(pid,'SIGTERM');}
  catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
}

const receipts=[],before=await sourceFingerprint(),installation=await installLocalPlugin();
try{for(let trial=1;trial<=trials;trial++){
  const journeyRoot=join(localRoot,`application-automation-${Date.now()}-${randomUUID()}`);
  let passed=false,storeRoot=null;
  try{
    const installedFixture=join(installation.installedRoot,'.workflows','fixtures','job-apply.synthetic-application-automation-v1');
    const prepared=JSON.parse(await run(process.execPath,[join(installedFixture,'prepare.mjs'),'--journey-root',journeyRoot,
      '--plugin-root',installation.installedRoot,'--workspace-root',repository]));
    storeRoot=prepared.storeRoot;
    const resultPath=join(journeyRoot,'agent-result.json'),decisionPath=join(journeyRoot,'decision.json');
    const router=join(installation.installedRoot,'apps','companion','command.mjs');
    const prompt=`$job-apply:job-apply Run the installed Job Apply skill for the committed synthetic local application-automation acceptance fixture. This is execution, not code work and not an Agent Workflows runner task. Follow the installed skill plus the exact synthetic protocol below.\n\n`
      +`Hard boundaries: do not edit repository files; do not use a browser, network, web search, real applicant data, real accounts, or any host except example.invalid. Use only the paths below. Never invoke the portal submit command. Stop at final review.\n\n`
      +`Current owner approval: I approve Campaign to Review for this exact synthetic job for 120 minutes, with no sensitive answer references, always stopping at final review. This approval applies only to the activation packet below.\n\n`
      +`Journey root: ${journeyRoot}\nStore root: ${prepared.storeRoot}\nJob ID: ${prepared.jobId}\nReady revision: ${prepared.readyRevision}\nPortal helper: ${prepared.portal}\n\n`
      +`Use only the installed public router at ${router}; never invoke runtime/cli files directly. Perform exactly this protocol:\n`
      +`1. Inspect saved setup with: node "${router}" store --root "${prepared.storeRoot}" profile-inspect. Require profile.applicationPreferences.preferredAutomationMode to be campaign_to_review. Treat it only as a preference, not authority.\n`
      +`2. Confirm the exact canonical job with the public task snapshot and select surfaces. Run: node "${router}" task --root "${prepared.storeRoot}" snapshot. Then run exactly: node "${router}" task --root "${prepared.storeRoot}" select --id ${prepared.jobId} --expected-revision ${prepared.readyRevision} --owner-confirmed. Require the exact job to remain Ready.\n`
      +`3. Start the detached attempt with: node "${router}" attempt --root "${prepared.storeRoot}" start --id ${prepared.jobId} --owner "Synthetic local acceptance" --expected-revision ${prepared.readyRevision}. Require event acquired.\n`
      +`4. Read live authority with: node "${router}" store --root "${prepared.storeRoot}" application-authority-status. Require mode guided and revision 0. Activate the approved exact scope once with: node "${router}" store --root "${prepared.storeRoot}" application-authority-set --input "${join(journeyRoot,'activation.json')}" --expected-revision 0. Require mode campaign_to_review, only the exact Job ID, a future expiration, and no sensitive answer references.\n`
      +`5. Inspect the portal with: node "${prepared.portal}" --command inspect --journey-root "${journeyRoot}".\n`
      +`6. Evaluate authority exactly once through the router attempt surface using "${join(journeyRoot,'evaluation.json')}" and save stdout to "${decisionPath}". Require ok true, event authority_evaluated, decision.authorized true, and mode campaign_to_review.\n`
      +`7. In this exact order, run the portal helper with --command apply --journey-root "${journeyRoot}" --decision "${decisionPath}" --operation OPERATION for: fill_canonical_profile, upload_managed_resume, fill_confirmed_answer, navigate_non_final.\n`
      +`8. Inspect again. Require stage final_review and finalAction.activated false. Do not activate it.\n`
      +`9. Commit the manual-review handoff through the router attempt surface with status awaiting_review and "${join(journeyRoot,'handoff.json')}".\n`
      +`10. Return only the JSON object required by the output schema. Set outcome passed only if the installed skill and public router completed every command and the final action remained untouched. Set authorityActivations to 1 and authorityEvaluations to 1.`;
    await runAgent(['exec','--ephemeral','--ignore-user-config','--ignore-rules',
      '--sandbox','danger-full-access','--model',model,
      '--config','approval_policy="never"','--color','never','-C',repository,'--output-schema',join(installedFixture,'result.schema.json'),
      '--output-last-message',resultPath,prompt],{CODEX_HOME:installation.codexHome});
    const receipt=JSON.parse(await run(process.execPath,[join(installedFixture,'evaluate.mjs'),'--journey-root',journeyRoot]));
    if(await sourceFingerprint()!==before)throw Error('live agent changed repository source state');
    receipts.push({trial,...receipt});passed=true;
  }finally{
    await stopBroker(storeRoot);
    if(passed&&!keep)await rm(journeyRoot,{recursive:true,force:false});
    else if(!passed)process.stderr.write(`Preserved failed local journey: ${journeyRoot}\n`);
  }
}}finally{await rm(installation.temporary,{recursive:true,force:true});}
process.stdout.write(`${JSON.stringify({ok:true,trials:receipts.length,receipts})}\n`);
