import { OutcomePolicy } from './outcomes.js';

/** Inert local authority. Final-control integration must inject its own trusted callback. */
export class FinalActionPolicyService extends OutcomePolicy {}
export type { PolicyOptions } from './repository.js';
export type { Activation, LeaseDecision, ReviewDecision } from './authorization.js';
export { PolicyError } from './model.js';
