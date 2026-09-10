import { JobTransitionsService } from '../workspace-core/job-transitions.js';
import type { ClaimRepository } from '../workspace-core/claims.js';
import { text, JobsError } from '../contracts/workspace/values.js';

export const jobTransitionCommands:Record<string,string[]>={
  'job-transition':['--id','--status','--expected-revision','--closed-outcome','--user-confirmed'],
};
export function runJobTransitionCommand(repository:ClaimRepository,options:Map<string,string>) {
  const required=(key:string):string=>{
    const value=options.get(key);
    if(!value)throw new JobsError(`required option: ${key}`);
    return value;
  };
  const revision=required('--expected-revision');
  if(!/^[+-]?[0-9]+$/.test(revision)||BigInt(revision)<1n)throw new JobsError('expected revision must be a positive integer');
  return new JobTransitionsService(repository).transition(required('--id'),required('--status'),BigInt(revision),
    options.has('--closed-outcome')?text(options.get('--closed-outcome')!):null,options.has('--user-confirmed'));
}
