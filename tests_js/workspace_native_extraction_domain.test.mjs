import assert from 'node:assert/strict';
import test from 'node:test';
import { ExtractionService, staleOpenRequests } from '../runtime/workspace-core/extraction.js';
import { parse, serialize, fromJSON, get, set, object, text, integer } from '../runtime/contracts/workspace/values.js';
import { validateExtractionRequests } from '../runtime/contracts/workspace/extraction-requests.js';
import { validatedCandidate, validateExtractions } from '../runtime/contracts/workspace/extraction-proposals.js';
const json = value => JSON.parse(serialize(value));
const now = '2026-09-09T00:00:00Z';
function fixture(profile = {}, provenance = {}) {
  let sequence = 0;
  let state = {
    profile:fromJSON({schemaVersion:1,profile,metadata:{revision:1,updatedAt:now,factProvenance:provenance}}),
    resumes:fromJSON({schemaVersion:1,resumes:{r:{id:'r',storageKind:'managed',digest:'a'.repeat(64),contentRevision:`content_${'a'.repeat(32)}`,revision:1,deletedAt:null}},metadata:{updatedAt:now}}),
    requests:fromJSON({schemaVersion:1,requests:{},metadata:{createdAt:now,updatedAt:now}}),
    proposals:fromJSON({schemaVersion:1,proposals:{},metadata:{createdAt:now,updatedAt:now}}),
  };
  const repository = {async extractionTransaction(operation) {
    const detached = Object.fromEntries(Object.entries(state).map(([key,value])=>[key,parse(serialize(value))]));
    return operation({...detached,files:{observation:async()=>({exists:true,digest:'a'.repeat(64)})},
      commit:async(kind,updates)=>{void kind; validateExtractionRequests(updates.requests ?? state.requests);validateExtractions(updates.proposals ?? state.proposals);state={...state,...updates};}});
  }};
  return {service:new ExtractionService(repository,()=>now,kind=>`${kind}-${++sequence}`),state:()=>state,
    resume:()=>object(get(object(get(state.resumes,'resumes'),'resumes'),'r'),'r')};
}
test('request completion tolerates metadata revisions and binds content identity; duplicate completion denied',async()=>{
  const f=fixture(),request=json(await f.service.createRequest('r',1n));
  set(f.resume(),'revision',integer(2n));
  const result=json(await f.service.completeRequest(request.requestId,fromJSON({name:'Alice'}),1n,1n));
  assert.equal(result.request.status,'completed');
  assert.equal(json(f.state().profile).profile.name,'Alice');
  assert.equal(json(f.state().profile).metadata.factProvenance['/name'].source,'resume');
  await assert.rejects(f.service.completeRequest(request.requestId,fromJSON({name:'Bob'}),2n,2n),/not open/);
  set(f.resume(),'revision',integer(3n));
  assert.equal(json(await f.service.getProposal(result.proposalSummary.id)).stale,false);
  set(f.resume(),'contentRevision',text(`content_${'b'.repeat(32)}`));
  assert.deepEqual(json(await f.service.getProposal(result.proposalSummary.id)).staleReasons,['resume_content_revision_changed']);
});
test('cancel, fail, retry ordering and replacement closure',async()=>{
  const f=fixture(),request=json(await f.service.createRequest('r',1n));
  await assert.rejects(f.service.createRequest('r',1n),/open extraction/);
  await f.service.failRequest(request.requestId,'interrupted',1n);
  const retry=json(await f.service.retryRequest(request.requestId,2n,1n));
  assert.equal(retry.supersedesRequestId,request.requestId);
  assert.deepEqual((await f.service.listRequests()).map(v=>json(v).requestId),[request.requestId,retry.requestId]);
  assert.equal(staleOpenRequests(f.state().requests,'r',now),true);
  assert.equal(json(await f.service.getRequest(retry.requestId)).status,'stale');
  const third=json(await f.service.retryRequest(retry.requestId,2n,1n));
  await f.service.cancelRequest(third.requestId,1n);
  await assert.rejects(f.service.retryRequest(third.requestId,2n,1n),/cannot be retried/);
});
test('explicit supersession, user provenance, replacements and partial review',async()=>{
  const f=fixture({name:'Existing',section:'old'},{'/name':{source:'user',updatedAt:now}});
  const candidate=fromJSON({name:'Extracted',section:{a:1,b:2}});
  const p=json(await f.service.createProposal('r',candidate,1n,1n));
  await assert.rejects(f.service.createProposal('r',candidate,1n,1n),/explicit supersession/);
  const next=json(await f.service.createProposal('r',candidate,1n,1n,p.id));
  assert.equal(json(await f.service.getProposal(p.id)).status,'superseded');
  await assert.rejects(f.service.reviewProposal(next.id,fromJSON({decisions:{'/section/a':'use_extracted'}}),1n,1n),/replacement confirmation/);
  let reviewed=json(await f.service.reviewProposal(next.id,fromJSON({decisions:{'/section/a':'use_extracted'},replacementConfirmations:{'/section/a':'/section'}}),1n,1n));
  assert.deepEqual(reviewed.pendingPaths,['/name','/section/b']);
  reviewed=json(await f.service.reviewProposal(next.id,fromJSON({decisions:{'/name':'keep_current','/section/b':'use_extracted'}}),2n,2n));
  assert.equal(reviewed.status,'completed');
  assert.deepEqual(json(f.state().profile).profile,{name:'Existing',section:{a:1,b:2}});
  assert.equal(json(f.state().profile).metadata.factProvenance['/section/b'].source,'user');
});
test('boolean baseline change is not equal to integer and failed review is atomic',async()=>{
  const f=fixture({flag:true}),p=json(await f.service.createProposal('r',fromJSON({flag:false}),1n,1n));
  set(object(get(f.state().profile,'profile'),'profile'),'flag',integer(1n));
  await assert.rejects(f.service.reviewProposal(p.id,fromJSON({decisions:{'/flag':'keep_current'}}),1n,1n),/baseline changed/);
  assert.equal(json(await f.service.getProposal(p.id)).revision,1);
});
test('candidate limits preserve arrays as atomic leaves and use UTF-8 size',()=>{
  assert.deepEqual(validatedCandidate(fromJSON({x:[null,{a:null}]}))[1],['/x']);
  assert.throws(()=>validatedCandidate(fromJSON({x:null})),/must not be null/);
  assert.throws(()=>validatedCandidate(fromJSON({x:'a'.repeat(32769)})),/structural limits/);
  assert.doesNotThrow(()=>validatedCandidate(fromJSON(Object.fromEntries(Array.from({length:8},(_,i)=>[`x${i}`,'é'.repeat(15000)])))));
  assert.throws(()=>validatedCandidate(fromJSON(Object.fromEntries(Array.from({length:513},(_,i)=>[`x${i}`,i])))),/structural limits/);
});

test('Python differential candidate and leaf baseline parity on synthetic values',async()=>{
  const {spawnSync}=await import('node:child_process');
  const {baseline}=await import('../runtime/contracts/workspace/extraction-pointers.js');
  const fixtures=[
    {profile:{section:'old'},candidate:{section:{a:1,b:2}}},
    {profile:{section:{},flag:true},candidate:{section:{x:[]},flag:false}},
    {profile:{section:null},candidate:{section:{'a/b':{'x~y':'é'}}}},
    {profile:{},candidate:{values:[null,{nested:null}]}},
  ];
  const python=spawnSync('python3',['-c',String.raw`
import json,sys
sys.path.insert(0,'scripts')
from job_apply_store.normalization import _pointer_baseline
from job_apply_store.validation.extraction import _validated_candidate
result=[]
for fixture in json.load(sys.stdin):
 candidate,paths=_validated_candidate(fixture['candidate'])
 result.append({'paths':paths,'baselines':{path:_pointer_baseline(fixture['profile'],path) for path in paths}})
print(json.dumps(result))
`],{cwd:new URL('..',import.meta.url),input:JSON.stringify(fixtures),encoding:'utf8'});
  assert.equal(python.status,0,python.stderr);
  const native=fixtures.map(fixture=>{
    const [,paths]=validatedCandidate(fromJSON(fixture.candidate));
    return {paths,baselines:Object.fromEntries(paths.map(path=>[path,json(baseline(fromJSON(fixture.profile),path))]))};
  });
  assert.deepEqual(native,JSON.parse(python.stdout));
});
