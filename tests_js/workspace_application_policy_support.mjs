import { fromJSON, get, object, serialize, set, text } from '../runtime/contracts/workspace/values.js';
import { initialApplicationAuthorityDocument } from '../runtime/contracts/workspace/application-authority.js';
import { makeClaim } from '../runtime/contracts/workspace/claims.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { JobTransitionsService } from '../runtime/workspace-core/job-transitions.js';
import { readyPacket } from './workspace_native_claims_support.mjs';
export { readyPacket };
export const at = '2026-09-10T12:00:00Z';
export const plain = value => JSON.parse(serialize(value));
export function fixture(status = 'saved') {
  const job = { id: 'job', url: 'https://example.invalid/job', normalizedUrl: 'https://example.invalid/job',
    role: 'Engineer', company: 'Synthetic', status, revision: 3, ats: 'greenhouse',
    createdAt: at, updatedAt: at, deletedAt: null, closedOutcome: status === 'closed' ? 'withdrawn' : null };
  const run = {runId:'run',status:'active',revision:1,
    selection:{resumeId:'resume',contentRevision:'content_'+'a'.repeat(32),factRevision:1,confirmedAt:at},
    queueVersions:[{revision:1,jobIds:['job'],updatedAt:at}],createdAt:at,updatedAt:at,completedAt:null};
  const observation = {exists:true,size:5,modifiedAt:at,digest:'a'.repeat(64)};
  const snapshot = {
    jobs: fromJSON({schemaVersion:1,jobs:{job},metadata:{updatedAt:at,applicationRuns:{activeRunId:'run',runs:{run}}}}),
    coordinator: fromJSON({schemaVersion:1,claim:null}),
    profile: fromJSON({profile:{name:'PRIVATE-PROFILE'}}),
    resumes: fromJSON({resumes:{resume:{id:'resume',storageKind:'managed',deletedAt:null,default:true,
      contentRevision:'content_'+'a'.repeat(32),observedSize:5,observedModifiedAt:at,digest:observation.digest}}}),
    answers: fromJSON({schemaVersion:1,metadata:{},redirects:{},answers:{}}),
    authority: initialApplicationAuthorityDocument(at), sessions:[], history:[],
    files: {observation:async()=>observation, externalObservation:async()=>observation,path:()=>'/PRIVATE-PATH'},
  };
  const writes = [], clock = {at};
  const tx = {...snapshot,saveJobs:async value=>writes.push(['jobs',value]),
    saveSession:async value=>writes.push(['session',value]),saveCoordinator:async value=>writes.push(['coordinator',value]),
    commit:async value=>writes.push(['commit',value])};
  const repository = {claimTransaction:async operation=>operation(tx)};
  const access = {token:null,ownerLabel:text('PRIVATE-OWNER')};
  const state = {snapshot:tx,writes,clock,access,observation,
    claims:new ClaimsService(repository,()=>clock.at), transitions:new JobTransitionsService(repository,()=>clock.at)};
  return state;
}
export function hold(state, id='job') {
  const {claim,token} = makeClaim(id,state.access.ownerLabel,at);
  set(state.snapshot.coordinator,'claim',claim);
  state.access.token=text(token);
  return token;
}
export const jobOf = state => object(get(object(get(state.snapshot.jobs,'jobs'),'jobs'),'job'),'job');
export function bytes(state) {
  return ['jobs','coordinator','profile','resumes','answers','authority','facts','requests'].map(key=>
    state.snapshot[key] ? serialize(state.snapshot[key]) : null).concat(
    state.snapshot.sessions.map(serialize),state.snapshot.history.map(serialize));
}
export function execute(state,candidate) {
  const {claims,transitions,access}=state;
  switch(candidate.kind) {
    case 'select': return claims.select('job',candidate.expectedRevision,candidate.ownerConfirmed);
    case 'acquire': return claims.acquire('job',access.ownerLabel,candidate.expectedRevision);
    case 'restart': return claims.restart('job',access.ownerLabel,candidate.expectedRevision,candidate.ownerConfirmedNotSubmitted);
    case 'recover': return claims.recover('job',access.ownerLabel);
    case 'progress': return claims.progress('job',access.token,candidate.incoming);
    case 'handoff': return claims.handoff('job',access.token,candidate.target,candidate.incoming,candidate.expectedRevision);
    case 'transition': return transitions.transition('job',candidate.target,candidate.expectedRevision,candidate.closedOutcome,candidate.userConfirmed);
    default: throw Error('test candidate unsupported');
  }
}
