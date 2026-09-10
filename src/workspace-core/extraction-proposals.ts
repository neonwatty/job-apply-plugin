import { copy, get, has, set, object, keys, string, text, integer, parse, serialize, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { safeId, emptyObject } from '../contracts/workspace/jobs.js';
import { validatedCandidate, proposalStatuses, extractionDecisions, validateExtractions } from '../contracts/workspace/extraction-proposals.js';
import { validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import { baseline, lookup, equal, replacementScope, setPointer, compareText } from '../contracts/workspace/extraction-pointers.js';
import { ExtractionRequests } from './extraction-requests.js';
import { records, profileRevision, readyResume, revision, closeRequest, touch } from './extraction-context.js';
import { createProposalState, proposalResult, proposalSummary, staleReasons, stampedProfile } from './extraction-proposal-state.js';
export class ExtractionProposals extends ExtractionRequests {
  createProposal(resumeId: string, candidate: Value, expectedResume: bigint, expectedProfile: bigint, supersedes: string | null = null): Promise<Document> {
    safeId(resumeId);
    validatedCandidate(candidate);
    return this.repository.extractionTransaction(async tx => {
      const resume = await readyResume(tx,resumeId,expectedResume);
      if (profileRevision(tx.profile) !== expectedProfile) throw new JobsError('profile revision conflict');
      const proposal = createProposalState(this,tx,resume,candidate,supersedes,false);
      await tx.commit('create',{profile:tx.profile,proposals:tx.proposals});
      return proposalResult(tx,proposal);
    });
  }
  completeRequest(id: string, candidate: Value, expectedRequest: bigint, expectedProfile: bigint, expectedPending: string | null = null): Promise<Document> {
    safeId(id);
    if (expectedPending !== null) safeId(expectedPending);
    validatedCandidate(candidate);
    return this.repository.extractionTransaction(async tx => {
      const value = get(records(tx.requests,'requests'),id);
      if (value === null) throw new JobsError('resume extraction request does not exist');
      const request = object(value,'request');
      revision(request,expectedRequest,'request revision conflict');
      if (string(get(request,'status')) !== 'requested') throw new JobsError('resume extraction request is not open');
      const resume = await readyResume(tx,string(get(request,'resumeId'))!);
      if (string(get(resume,'contentRevision')) !== string(get(request,'resumeContentRevision'))) throw new JobsError('resume content revision conflict');
      if (profileRevision(tx.profile) !== expectedProfile) throw new JobsError('profile revision conflict');
      const proposal = createProposalState(this,tx,resume,candidate,expectedPending,true);
      const completed = closeRequest(tx.requests,id,expectedRequest,'completed',this.now(),null,string(get(proposal,'id')));
      validateExtractionRequests(tx.requests);
      await tx.commit('request-complete',{profile:tx.profile,proposals:tx.proposals,requests:tx.requests});
      return set(set(emptyObject(),'request',completed),'proposalSummary',proposalSummary(proposal,false));
    });
  }
  getProposal(id: string): Promise<Document | null> {
    safeId(id);
    return this.repository.extractionTransaction(async tx => {
      const value = get(records(tx.proposals,'proposals'),id);
      return value === null ? null : proposalResult(tx,object(value,'proposal'));
    });
  }
  listProposals(resumeId?: string, status?: string, summaryOnly = false): Promise<Document[]> {
    if (resumeId !== undefined) safeId(resumeId);
    if (status !== undefined && !proposalStatuses.has(status)) throw new JobsError('resume proposal status is unsupported');
    return this.repository.extractionTransaction(async tx => {
      const selected = records(tx.proposals,'proposals').entries().map(([,value]) => object(value,'proposal'))
        .filter(record => (resumeId === undefined || string(get(record,'resumeId')) === resumeId)
          && (status === undefined || string(get(record,'status')) === status))
        .sort((a,b) => compareText(string(get(a,'createdAt'))!,string(get(b,'createdAt'))!) || compareText(string(get(a,'id'))!,string(get(b,'id'))!));
      return Promise.all(selected.map(record => summaryOnly ? proposalSummary(record) : proposalResult(tx,record)));
    });
  }
  reviewProposal(id: string, input: Value, expected: bigint, expectedProfile: bigint): Promise<Document> {
    safeId(id);
    const review = object(input,'proposal review'), choices = records(review,'decisions');
    const confirmations = has(review,'replacementConfirmations') ? records(review,'replacementConfirmations') : emptyObject();
    if (!choices.size || keys(review).some(key => !['decisions','replacementConfirmations'].includes(key))) throw new JobsError('proposal review must contain decisions');
    if (choices.entries().some(([,value]) => !extractionDecisions.has(string(value)!))) throw new JobsError('proposal review decision is unsupported');
    return this.repository.extractionTransaction(async tx => {
      const value = get(records(tx.proposals,'proposals'),id);
      if (value === null) throw new JobsError('resume proposal does not exist');
      const current = object(value,'proposal');
      revision(current,expected,'resume proposal revision conflict');
      if (string(get(current,'status')) !== 'pending') throw new JobsError('resume proposal is not pending');
      if ((await staleReasons(tx,current)).length) throw new JobsError('resume proposal is stale');
      const pending = (get(current,'pendingPaths') as Value[]).map(item => string(item)!);
      if (keys(choices).some(path => !pending.includes(path))) throw new JobsError('proposal review path is not pending');
      if (profileRevision(tx.profile) !== expectedProfile) throw new JobsError('profile revision conflict');
      const baselines = copy(records(current,'baselines')), required = emptyObject();
      for (const [key,choice] of choices.entries()) {
        const path = string(key)!;
        if (!equal(baseline(records(tx.profile,'profile'),path),get(baselines,path))) throw new JobsError('proposal review baseline changed');
        const replacement = replacementScope(records(baselines,path));
        if (string(choice) === 'use_extracted' && replacement !== null) set(required,path,text(replacement));
      }
      if (!equal(confirmations,required)) throw new JobsError('proposal review replacement confirmation is required');
      const now = this.now(), profile = object(parse(serialize(get(tx.profile,'profile'))),'profile'), accepted: string[] = [];
      for (const [key,choice] of choices.entries()) if (string(choice) === 'use_extracted') {
        const path = string(key)!;
        setPointer(profile,path,lookup(get(current,'candidate'),path)[1],true);
        accepted.push(path);
      }
      if (accepted.length) tx.profile = stampedProfile(tx.profile,profile,accepted,'user',now);
      const remaining = pending.filter(path => !choices.has(text(path))), decisions = copy(records(current,'decisions'));
      for (const path of remaining) set(baselines,path,baseline(profile,path));
      for (const [key,choice] of choices.entries()) set(decisions,string(key)!,set(set(emptyObject(),'decision',choice),'decidedAt',text(now)));
      set(current,'pendingPaths',remaining.map(text));
      set(current,'baselines',baselines);
      set(current,'decisions',decisions);
      set(current,'status',text(remaining.length ? 'pending':'completed'));
      set(current,'resultProfileRevision',integer(profileRevision(tx.profile)));
      set(current,'revision',integer(expected+1n));
      set(current,'updatedAt',text(now));
      touch(tx.proposals,now);
      validateExtractions(tx.proposals);
      await tx.commit('review',{profile:tx.profile,proposals:tx.proposals});
      return proposalResult(tx,current);
    });
  }
}
