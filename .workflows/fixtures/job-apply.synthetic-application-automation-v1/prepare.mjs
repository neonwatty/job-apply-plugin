import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeJobsFixture, NativeJobsRepository } from '../../../runtime/store/native-jobs.js';
import { resolvePackagedNativeLock } from '../../../runtime/package/native-lock-artifact.js';
import { loadPosixFlockProvider } from '../../../runtime/store/posix-flock.js';
import { JobsService } from '../../../runtime/workspace-core/jobs.js';
import { ResumeService } from '../../../runtime/workspace-core/resumes.js';
import { ResumeFactsService } from '../../../runtime/workspace-core/resume-facts.js';
import { ApplicationRunsService } from '../../../runtime/workspace-core/application-runs.js';
import { ClaimsService } from '../../../runtime/workspace-core/claims.js';
import { fromJSON, get, int, string } from '../../../runtime/contracts/workspace/values.js';

const directory=dirname(fileURLToPath(import.meta.url)),repository=resolve(directory,'../../..');
const fixture=JSON.parse(await readFile(join(directory,'fixture.json'),'utf8'));
const requested=process.argv[2]==='--journey-root'?process.argv[3]:null;
if(!requested||requested!==resolve(requested)||fixture.syntheticOnly!==true)throw Error('Usage: node prepare.mjs --journey-root /absolute/disposable/root');
await mkdir(requested,{recursive:false,mode:0o700});const journeyRoot=await realpath(requested);
if(journeyRoot!==requested||!journeyRoot.includes(`${join(repository,'.workflows','local')}/`))throw Error('journey root must be under .workflows/local');
const storeRoot=join(journeyRoot,'store');await initializeJobsFixture(storeRoot);
const lock=await resolvePackagedNativeLock(repository),repositoryStore=new NativeJobsRepository(storeRoot,loadPosixFlockProvider(lock));
const now=()=>new Date().toISOString().replace(/\.\d{3}Z$/u,'Z');
const profilePath=join(storeRoot,'profile.json'),profileDocument=JSON.parse(await readFile(profilePath,'utf8'));
const applicant={name:'Synthetic Applicant',email:'synthetic@example.invalid',phone:'000-000-0000',location:'Local Fixture'};
profileDocument.profile={...applicant,applicationPreferences:{preferredBrowser:'codex_browser',browserFallback:'ask',
  progressionMode:'standard',preferredAutomationMode:'campaign_to_review'}};
await writeFile(profilePath,`${JSON.stringify(profileDocument)}\n`,{mode:0o600});
const resume=await new ResumeService(repositoryStore,now).import(fromJSON(fixture.resume),'resume.txt',await readFile(join(directory,'resume.txt')));
const facts=new ResumeFactsService(repositoryStore,now),resumeRevision=int(get(resume,'revision'));
const draft=await facts.createDraft(fixture.resume.id,fromJSON(applicant),resumeRevision,null);
const confirmed=await facts.confirm(fixture.resume.id,int(get(draft,'revision')),string(get(draft,'contentRevision')));
const job=await new JobsService(repositoryStore,now).create(fromJSON(fixture.job));
const run=await new ApplicationRunsService(repositoryStore,now).start(fixture.resume.id,resumeRevision,int(get(confirmed,'revision')),true,
  fromJSON({jobIds:[fixture.job.id]}));
const ready=await new ClaimsService(repositoryStore,now).select(fixture.job.id,int(get(job,'revision')),true);
await writeFile(join(journeyRoot,'activation.json'),`${JSON.stringify({mode:'campaign_to_review',runId:string(get(run,'runId')),
  jobIds:[fixture.job.id],sensitiveAnswerRefs:[],durationMinutes:120})}\n`,{mode:0o600});
const portal={schemaVersion:1,fixtureId:fixture.fixtureId,syntheticOnly:true,destinationUrl:fixture.job.url,stage:'form',
  requiredOperations:fixture.requiredOperations,completedOperations:[],finalActionLabel:fixture.finalActionLabel,finalActionActivated:false,audit:[]};
await writeFile(join(journeyRoot,'portal-state.json'),`${JSON.stringify(portal)}\n`,{mode:0o600});
await writeFile(join(journeyRoot,'evaluation.json'),`${JSON.stringify({destinationUrl:fixture.job.url,operations:fixture.requiredOperations,
  answerRefs:[],sensitiveAnswerRefs:[],interrupts:{missingOrUncertainData:false,captcha:false,mfa:false,emailVerification:false,
    providerLegalConsent:false,unsupportedControls:false,unexpectedDestination:false,ambiguity:false,finalAction:false}})}\n`,{mode:0o600});
const readiness=JSON.parse(await readFile(join(repository,'qa/fixtures/greenhouse-form-readiness-v1/fixture.json'),'utf8'));
const controls=readiness.steps.flatMap(step=>step.controls),requiredControlIds=controls.filter(control=>control.required).map(control=>control.id).sort();
const fingerprint=createHash('sha256').update(JSON.stringify({platformFamily:readiness.platformFamily,requiredControlIds})).digest('hex');
const kinds={textbox:'text',combobox:'selection',radiogroup:'selection',checkbox:'toggle',file:'upload'};
const handoff={status:'review',readinessInput:{attemptRevision:3,evidenceKind:'agent_attested_current_attempt',fixture:readiness,
  expectedObservationRevision:7,formManifest:{schemaVersion:1,platformFamily:readiness.platformFamily,observationRevision:7,
    requiredControlIds,controlSetFingerprint:`sha256:${fingerprint}`,complete:true},observation:{schemaVersion:1,
    platformFamily:readiness.platformFamily,observationRevision:7,adapterState:'accessible',uploadCapability:'available',
    controls:controls.map(control=>({controlId:control.id,kind:kinds[control.role],state:control.role==='file'?'accepted':'complete',observationRevision:7})),
    validationErrorControlIds:[],finalControlState:'available'}}};
await writeFile(join(journeyRoot,'handoff.json'),`${JSON.stringify(handoff)}\n`,{mode:0o600});
process.stdout.write(`${JSON.stringify({fixtureId:fixture.fixtureId,journeyRoot,storeRoot,jobId:fixture.job.id,
  readyRevision:Number(int(get(get(ready,'job'),'revision'))),preferredAutomationMode:'campaign_to_review',portal:join(directory,'portal.mjs')})}\n`);
