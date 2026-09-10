import { ClaimsService } from './claims.js';
import type { ClaimRepository } from './claims.js';
import { get, int, keys, object, parse, serialize, string, JobsError } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';

/** Authenticated transport supplies body bounds; bearer credentials are never logged. */
export async function claimsHttp(repository:ClaimRepository,method:string,path:string,body:string):Promise<{status:number;body:string}|null> {
  const service = new ClaimsService(repository);
  if (method === 'GET' && path === '/api/claims') return {status:200,body:serialize(await service.status())};
  const shapes:Record<string,string[]> = {
    select:['jobId','expectedRevision','ownerConfirmed'], acquire:['jobId','ownerLabel','expectedRevision'],
    heartbeat:['jobId','token'],recover:['jobId','ownerLabel'],progress:['jobId','token','session'],
    handoff:['jobId','token','status','session','expectedRevision'],
  };
  const action = path.startsWith('/api/claims/') ? path.slice('/api/claims/'.length) : '';
  const fields = shapes[action];
  if (method !== 'POST' || !fields) return null;
  const payload = object(parse(body),'claim body');
  if (payload.size !== fields.length || keys(payload).some(key => !fields.includes(key))) throw new JobsError('claim body contains unsupported or missing fields');
  const id = string(get(payload,'jobId'));
  if (id === null) throw new JobsError('claim job id must be a string');
  const revision = ():bigint => {
    const value = int(get(payload,'expectedRevision'));
    if (value === null) throw new JobsError('expected revision must be an integer');
    return value;
  };
  let result:Value;
  if (action === 'select') result = await service.select(id,revision(),get(payload,'ownerConfirmed') === true);
  else if (action === 'acquire') result = await service.acquire(id,get(payload,'ownerLabel'),revision());
  else if (action === 'heartbeat') result = await service.heartbeat(id,get(payload,'token'));
  else if (action === 'recover') result = await service.recover(id,get(payload,'ownerLabel'));
  else if (action === 'progress') result = await service.progress(id,get(payload,'token'),object(get(payload,'session'),'session'));
  else {
    const status = string(get(payload,'status'));
    if (status === null) throw new JobsError('claimed handoff status is unsupported');
    result = await service.handoff(id,get(payload,'token'),status,object(get(payload,'session'),'session'),revision());
  }
  return {status:200,body:serialize(result)};
}
