import { randomUUID } from 'node:crypto';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
import { exact, record, snapshot } from './validation.js';

export interface UserEventBinding { eventFingerprint: string; inputRevision: string }
export interface UserEventVerifier {
  require(binding: UserEventBinding): void;
  close(): void;
}
const lifetimeLimit = 300_000, grantLimit = 64;
const denied = (): never => { throw new TaskProtocolError('user_event_required'); };
function key(binding: UserEventBinding): string {
  const value = record(snapshot(binding), 'invalid_event');
  exact(value, ['eventFingerprint', 'inputRevision'], 'invalid_event');
  if (typeof value.eventFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.eventFingerprint)
    || typeof value.inputRevision !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputRevision)) return denied();
  return `${value.eventFingerprint}:${value.inputRevision}`;
}

/** Separate in-process ports: only the trusted host retains approvals. Never publish it to model tools.
 * Grants permit exact idempotent retries until expiry/revocation; they are not reusable consent.
 * The caller authenticates the human event. This module cannot authenticate a chat transcript.
 */
export function createUserEventAuthority(now: () => number = () => performance.now()) {
  const grants = new Map<string, { key: string; expires: number }>();
  let closed = false, lastTime = -Infinity;
  const close = () => { closed = true; grants.clear(); };
  const clock = () => {
    const value = now();
    if (closed || !Number.isFinite(value) || value < lastTime) { close(); return denied(); }
    lastTime = value;
    for (const [id, grant] of grants) if (grant.expires <= value) grants.delete(id);
    return value;
  };
  const approvals = Object.freeze({
    approve(binding: UserEventBinding, lifetimeMilliseconds: number): string {
      const value = key(binding), at = clock();
      if (!Number.isSafeInteger(lifetimeMilliseconds) || lifetimeMilliseconds < 1
        || lifetimeMilliseconds > lifetimeLimit || grants.size >= grantLimit) return denied();
      const id = randomUUID();
      grants.set(id, { key: value, expires: at + lifetimeMilliseconds });
      return id;
    },
    revoke(id: string): void { grants.delete(id); },
    close,
  });
  const verifier: UserEventVerifier = Object.freeze({
    require(binding: UserEventBinding): void {
      const value = key(binding); clock();
      if (![...grants.values()].some(grant => grant.key === value)) denied();
    },
    close,
  });
  return Object.freeze({ approvals, verifier });
}
