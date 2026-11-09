import { copy, get, set, int, integer, object, string, text, fromJSON, parse, serialize, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { validatedCandidate, validateExtractions } from '../contracts/workspace/extraction-proposals.js';
import { baseline, lookup, setPointer } from '../contracts/workspace/extraction-pointers.js';
import { provenanceAfter } from './profile-patch.js';
import { records, profileRevision, touch } from './extraction-context.js';
import type { ExtractionContext, ExtractionTransaction } from './extraction-context.js';
export function stampedProfile(document: Document, profile: Document, paths: string[], source: string, now: string): Document {
  const metadata = copy(records(document,'metadata'));
  const provenance = get(metadata,'factProvenance') === null ? emptyObject() : records(metadata,'factProvenance');
  set(metadata,'revision',integer(profileRevision(document)+1n));
  set(metadata,'updatedAt',text(now));
  set(metadata,'factProvenance',provenanceAfter(provenance,paths,source,now,records(document,'profile')));
  return set(set(copy(document),'profile',profile),'metadata',metadata);
}
export function createProposalState(context: ExtractionContext, tx: ExtractionTransaction, resume: Document,
  input: Value, supersedes: string | null, bind: boolean): Document {
  const [candidate,paths] = validatedCandidate(input), proposals = records(tx.proposals,'proposals');
  const pending = proposals.entries().map(([,value]) => object(value,'proposal')).find(record =>
    string(get(record,'resumeId')) === string(get(resume,'id')) && string(get(record,'status')) === 'pending');
  if (pending ? supersedes !== string(get(pending,'id')) : supersedes !== null) {
    throw new JobsError(pending ? 'pending proposal requires explicit supersession' : 'proposal to supersede does not exist');
  }
  const now = context.now(), id = context.id('proposal'), initialRevision = profileRevision(tx.profile);
  const profile = object(parse(serialize(get(tx.profile,'profile'))),'profile');
  const metadata = records(tx.profile,'metadata'), provenance = get(metadata,'factProvenance') === null ? emptyObject() : records(metadata,'factProvenance');
  const baselines = emptyObject(), auto: string[] = [], pendingPaths: string[] = [];
  for (const path of paths) set(baselines,path,baseline(records(tx.profile,'profile'),path));
  for (const path of paths) {
    const item = records(baselines,path);
    const ancestorsAllow = (get(item,'ancestors') as Value[]).every(value => {
      const ancestor = object(value,'ancestor');
      return get(ancestor,'exists') === false || get(ancestor,'container') === true && get(ancestor,'empty') === false
        || ancestor.has(text('value')) && get(ancestor,'value') === null;
    });
    const protectedPath = provenance.entries().some(([key,value]) => {
      const name = string(key)!;
      return string(get(object(value,'provenance'),'source')) === 'user' && (name === path || name.startsWith(`${path}/`) || path.startsWith(`${name}/`));
    });
    if ((get(item,'exists') === false || get(item,'value') === null) && ancestorsAllow && !protectedPath) {
      setPointer(profile,path,lookup(candidate,path)[1],false);
      auto.push(path);
    } else pendingPaths.push(path);
  }
  if (auto.length) tx.profile = stampedProfile(tx.profile,profile,auto,'resume',now);
  if (pending) {
    set(pending,'status',text('superseded'));
    set(pending,'supersededBy',text(id));
    set(pending,'revision',integer(int(get(pending,'revision'))!+1n));
    set(pending,'updatedAt',text(now));
  }
  const proposal = object(fromJSON({ id, autoFilledPaths:auto, pendingPaths, decisions:{}, status:pendingPaths.length ? 'pending':'completed',
    revision:1, createdAt:now, updatedAt:now, supersededBy:null }),'proposal');
  set(proposal,'resumeId',get(resume,'id'));
  set(proposal,'resumeRevision',get(resume,'revision'));
  set(proposal,'resumeDigest',get(resume,'digest'));
  set(proposal,'profileRevision',integer(initialRevision));
  set(proposal,'resultProfileRevision',integer(profileRevision(tx.profile)));
  set(proposal,'candidate',candidate);
  set(proposal,'baselines',baselines);
  if (bind) set(proposal,'resumeContentRevision',get(resume,'contentRevision'));
  set(proposals,id,proposal);
  touch(tx.proposals,now);
  validateExtractions(tx.proposals);
  return proposal;
}
export async function staleReasons(tx: ExtractionTransaction, proposal: Document): Promise<string[]> {
  const value = get(records(tx.resumes,'resumes'),string(get(proposal,'resumeId'))!);
  if (value === null) return ['resume_deleted'];
  const resume = object(value,'resume'), reasons: string[] = [];
  if (get(resume,'deletedAt') !== null) reasons.push('resume_trashed');
  if (string(get(resume,'storageKind')) !== 'managed') return [...reasons,'resume_not_managed'];
  if (get(proposal,'resumeContentRevision') !== null) {
    if (string(get(resume,'contentRevision')) !== string(get(proposal,'resumeContentRevision'))) reasons.push('resume_content_revision_changed');
  } else {
    if (int(get(resume,'revision')) !== int(get(proposal,'resumeRevision'))) reasons.push('resume_revision_changed');
    if (string(get(resume,'digest')) !== string(get(proposal,'resumeDigest'))) reasons.push('resume_digest_changed');
  }
  const observed = await tx.files.observation(resume);
  if (!observed.exists) reasons.push('resume_file_missing');
  else if (observed.digest !== string(get(resume,'digest'))) reasons.push('resume_file_changed');
  return reasons;
}
export async function proposalResult(tx: ExtractionTransaction, proposal: Document): Promise<Document> {
  const reasons = await staleReasons(tx,proposal);
  return set(set(copy(proposal),'stale',reasons.length > 0),'staleReasons',reasons.map(text));
}
export function proposalSummary(proposal: Document, includeResume = true): Document {
  const result = emptyObject();
  for (const key of ['id','status','revision',...(includeResume ? ['resumeId']:[])]) set(result,key,get(proposal,key));
  set(result,'autoFilledCount',integer(BigInt((get(proposal,'autoFilledPaths') as Value[]).length)));
  set(result,'pendingCount',integer(BigInt((get(proposal,'pendingPaths') as Value[]).length)));
  return result;
}
