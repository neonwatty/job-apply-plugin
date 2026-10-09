import { randomUUID } from 'node:crypto';
import { inspectSavedClaimHandoff } from '../contracts/workspace/saved-claim-session.js';
import { claimHeartbeatSeconds, claimLeaseSeconds, heartbeatClaim, makeClaim, publicClaim, requireClaim, requireJobUnclaimed } from '../contracts/workspace/claims.js';
import { safeId, validateJob } from '../contracts/workspace/jobs.js';
import { requireClaimOwner, requireSelectionIntent, requireRestartConfirmation, requireJobRevision, requireHandoffTarget } from '../contracts/workspace/application-intents.js';
import { copy, fromJSON, get, has, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { NativeResumeFiles } from '../store/native-resume-files.js';
import { activeApplicationJob, inspectSelection, inspectAcquisition, inspectReviewRestart, inspectRecovery, inspectProgress, inspectHandoff } from '../contracts/workspace/application-policy.js';
import { consumeAutofillAuthority } from '../contracts/workspace/application-authority.js';

export interface ClaimTransaction {
  jobs: Document; coordinator: Document; profile: Document; resumes: Document; facts?: Document; requests?: Document; answers: Document;
  authority: Document;
  sessions: Document[]; history: Document[]; files: NativeResumeFiles;
  saveJobs(document:Document):Promise<void>;
  saveCoordinator(document:Document):Promise<void>;
  saveSession(document:Document):Promise<void>;
  commit(operation:Document):Promise<void>;
}
export interface ClaimRepository {
  claimTransaction<T>(operation:(transaction:ClaimTransaction)=>Promise<T>):Promise<T>;
}
const doc = (value: unknown): Document => object(fromJSON(value),'claim result');
function transitioned(job:Document,target:string,at:string):Document {
  const result = copy(job);
  set(result,'status',text(target));set(result,'closedOutcome',null);
  set(result,'revision',integer(int(get(job,'revision'))!+1n));set(result,'updatedAt',text(at));
  if (has(result, 'inputSelection')) set(object(get(result, 'inputSelection'), 'input selection'),
    'jobRevision', get(result, 'revision'));
  return validateJob(string(get(job,'id'))!,result);
}
function projectJob(job:Document):Document {
  const result = doc({});
  for (const field of ['id','role','company','location','workplaceType','employmentType','status','priority','revision','createdAt','updatedAt']) if (has(job,field)) set(result,field,get(job,field));
  return result;
}
function operation(kind:string,job:Document,at:string,eventName:string,status:string,claim:Value):Document {
  const operationId = randomUUID(), id = string(get(job,'id'))!;
  const event = doc({schemaVersion:1,eventId:`coordinator-${operationId}`,applicationId:id,event:eventName,status,answerKeys:[],at});
  for (const field of ['company','role','ats']) if (string(get(job,field)) !== null) set(event,field,get(job,field));
  const result = doc({kind,operationId,jobId:id,at});
  set(result,'historyEvent',event);set(result,'resultClaim',claim);
  if (kind !== 'recover') {
    set(result,'sourceStatus',get(job,'status'));set(result,'targetStatus',text(status));set(result,'expectedRevision',get(job,'revision'));
  }
  return result;
}
export class ClaimsService {
  constructor(private readonly repository:ClaimRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/,'Z')) {}
  status():Promise<Value> {
    return this.repository.claimTransaction(async tx => set(doc({leaseSeconds:claimLeaseSeconds,heartbeatSeconds:claimHeartbeatSeconds}),'claim',publicClaim(get(tx.coordinator,'claim'),this.now())));
  }
  confirmInput(id:string,resumeId:string,expectedJob:bigint,expectedResume:bigint,
    expectedFacts:bigint,confirmed:boolean):Promise<Value> {
    safeId(id);safeId(resumeId);
    if (!confirmed) throw new JobsError('resume and facts require owner confirmation in chat');
    return this.repository.claimTransaction(async tx => {
      const job = activeApplicationJob(tx,id);
      if (int(get(job,'revision')) !== expectedJob) throw new JobsError('job revision conflict');
      if (!['saved','needs_info','ready'].includes(string(get(job,'status'))!)) throw new JobsError('job cannot change its input selection');
      requireJobUnclaimed(tx.coordinator,id);
      const resumeValue = get(object(get(tx.resumes,'resumes'),'resumes'),resumeId);
      if (resumeValue === null) throw new JobsError('resume does not exist');
      const resume = object(resumeValue,'resume');
      if (get(resume,'deletedAt') !== null || string(get(resume,'storageKind')) !== 'managed'
        || int(get(resume,'revision')) !== expectedResume) throw new JobsError('resume revision conflict');
      const observation = await tx.files.observation(resume);
      if (!observation.exists || observation.digest !== string(get(resume,'digest'))) throw new JobsError('resume file changed');
      const setValue = tx.facts ? get(object(get(tx.facts,'sets'),'resume fact sets'),resumeId) : null;
      const versions = setValue === null ? null : get(object(setValue,'resume fact set'),'versions');
      const latest = Array.isArray(versions) && versions.length ? object(versions[versions.length-1]!,'resume facts') : null;
      if (!latest || int(get(latest,'revision')) !== expectedFacts || string(get(latest,'state')) !== 'confirmed'
        || string(get(latest,'contentRevision')) !== string(get(resume,'contentRevision')))
        throw new JobsError('confirmed resume facts are unavailable or stale');
      const next = copy(job), now = this.now();
      set(next,'resumeId',text(resumeId));
      set(next,'revision',integer(expectedJob+1n));set(next,'updatedAt',text(now));
      const selection = doc({resumeId,contentRevision:string(get(resume,'contentRevision')),
        factRevision:null,jobRevision:null,confirmedAt:now});
      set(selection,'factRevision',integer(expectedFacts));set(selection,'jobRevision',integer(expectedJob+1n));
      set(next,'inputSelection',selection);
      validateJob(id,next);
      set(object(get(tx.jobs,'jobs'),'jobs'),id,next);
      set(object(get(tx.jobs,'metadata'),'jobs metadata'),'updatedAt',text(now));
      await tx.saveJobs(tx.jobs);
      const result = doc({resumeId});set(result,'factRevision',integer(expectedFacts));
      set(result,'jobRevision',integer(expectedJob+1n));return set(result,'job',projectJob(next));
    });
  }
  select(id:string,expectedRevision:bigint,confirmed:boolean):Promise<Value> {
    safeId(id);
    requireSelectionIntent(confirmed,expectedRevision);
    return this.repository.claimTransaction(async tx => {
      const job = await inspectSelection(tx,id,expectedRevision);
      if (string(get(job,'status')) === 'ready') return set(doc({action:'noop'}),'job',projectJob(job));
      const updated = transitioned(job,'ready',this.now());
      set(object(get(tx.jobs,'jobs'),'jobs'),id,updated);
      set(object(get(tx.jobs,'metadata'),'jobs.metadata'),'updatedAt',get(updated,'updatedAt'));
      await tx.saveJobs(tx.jobs);
      return set(doc({action:'ready'}),'job',projectJob(updated));
    });
  }
  acquire(id:string,ownerLabel:Value,expectedRevision:bigint):Promise<Value> {
    safeId(id);requireClaimOwner(ownerLabel);
    return this.repository.claimTransaction(async tx => {
      const {job,preflight} = await inspectAcquisition(tx,id,expectedRevision,this.now);
      const now = this.now(), {claim,token} = makeClaim(id,ownerLabel,now);
      const resume = copy(object(get(object(get(tx.resumes,'resumes'),'resumes'),string(get(preflight,'resumeId'))!),'resume'));
      set(resume,'path',string(get(resume,'storageKind')) === 'managed' ? text(tx.files.path(resume)) : get(resume,'path'));
      await tx.commit(operation('acquire',job,now,'job-started','in_progress',claim));
      const result = doc({token});set(result,'job',transitioned(job,'in_progress',now));set(result,'resume',resume);
      return set(result,'claim',publicClaim(claim,this.now()));
    });
  }
  restart(id:string,ownerLabel:Value,expectedRevision:bigint,ownerConfirmedNotSubmitted:boolean):Promise<Value> {
    safeId(id);
    requireRestartConfirmation(ownerConfirmedNotSubmitted);
    requireClaimOwner(ownerLabel);
    requireJobRevision(expectedRevision);
    return this.repository.claimTransaction(async tx => {
      const {job,resume:rawResume,event} = await inspectReviewRestart(tx,id,expectedRevision,this.now);
      const resume = copy(rawResume);
      set(resume,'path',text(tx.files.path(resume)));
      const now = this.now(), {claim,token} = makeClaim(id,ownerLabel,now);
      // The prior review remains immutable evidence; new progress belongs to the new revision.
      await tx.commit(operation('review_restart',job,now,event,'in_progress',claim));
      const result = doc({token});set(result,'job',transitioned(job,'in_progress',now));set(result,'resume',resume);
      return set(result,'claim',publicClaim(claim,this.now()));
    });
  }
  heartbeat(id:string,token:Value):Promise<Value> {
    return this.repository.claimTransaction(async tx => {
      const claim = requireClaim(tx.coordinator,tx.jobs,id,token,this.now());
      const updated = heartbeatClaim(claim,this.now());
      await tx.saveCoordinator(set(doc({schemaVersion:1}),'claim',updated));
      return set(doc({}),'claim',publicClaim(updated,this.now()));
    });
  }
  recover(id:string,ownerLabel:Value):Promise<Value> {
    safeId(id);requireClaimOwner(ownerLabel);
    return this.repository.claimTransaction(async tx => {
      const job = inspectRecovery(tx,id,this.now), now = this.now(), {claim,token} = makeClaim(id,ownerLabel,now);
      await tx.commit(operation('recover',job,now,'claim-recovered','in_progress',claim));
      const result = doc({token});set(result,'job',job);
      return set(result,'claim',publicClaim(claim,this.now()));
    });
  }
  progress(id:string,token:Value,incoming:Document):Promise<Value> {
    return this.repository.claimTransaction(async tx => {
      const session = await inspectProgress(tx,id,token,incoming,this.now);
      await tx.saveSession(session);
      return session;
    });
  }
  /** Internal workflow operation: keep historical checkpoint state without fabricating observations. */
  handoffSaved(id:string,token:Value,expectedRevision:bigint,fingerprint:string):Promise<Value> {
    return this.repository.claimTransaction(async tx => {
      const {job,session,at} = inspectSavedClaimHandoff(tx,id,token,expectedRevision,fingerprint,this.now());
      return this.commitHandoff(tx,job,session,'needs_info',at);
    });
  }
  private async commitHandoff(tx:ClaimTransaction,job:Document,session:Document,status:string,now:string):Promise<Value> {
    const id = string(get(job,'id'))!;
    const op = operation('handoff',job,now,status === 'needs_info' ? 'job-blocked' : 'reviewed',status,null);
    if (status === 'awaiting_review') {
      const authority = consumeAutofillAuthority(tx.authority, id, now);
      if (authority !== null) set(op, 'applicationAuthority', authority);
    }
    set(op,'session',session);await tx.commit(op);
    const result = doc({claim:null});set(result,'job',transitioned(job,status,now));return set(result,'session',session);
  }
  handoff(id:string,token:Value,status:string,incoming:Document,expectedRevision:bigint):Promise<Value> {
    requireHandoffTarget(status);
    return this.repository.claimTransaction(async tx => {
      const {job,session,at:now} = await inspectHandoff(tx,id,token,status,incoming,expectedRevision,this.now);
      return this.commitHandoff(tx,job,session,status,now);
    });
  }
}
