import { browserMutation, BrowserBoundaryError, requestFingerprint } from '../../contracts/workspace/browser-boundary.js';
import type { BrowserAuthority, BrowserMutation } from '../../contracts/workspace/browser-boundary.js';
import { browserValueGrant } from '../../contracts/workspace/browser-authority.js';
import type { BrowserValueGrant } from '../../contracts/workspace/browser-authority.js';
import { identifier } from '../../harness/validation.js';

export interface WorkflowBrowserAuthorityPort {
  checkBrowserAuthority(request: BrowserMutation, grant: BrowserValueGrant):
    Promise<{ authorized: boolean; requestFingerprint: string }>;
}

/** Trusted configuration maps opaque references to canonical sources, never model classifications. */
export function createBrowserAuthority(workflow: WorkflowBrowserAuthorityPort,
  incoming: ReadonlyMap<string, BrowserValueGrant>, controlValues: ReadonlyMap<string, string>): BrowserAuthority {
  if (incoming.size > 256 || controlValues.size > 256) throw new BrowserBoundaryError('invalid_browser_input');
  const grants = new Map<string, BrowserValueGrant>();
  for (const [ref, grant] of incoming) {
    identifier(ref, 'invalid_arguments');
    grants.set(ref, browserValueGrant(grant));
  }
  const controls = new Map<string, string>();
  for (const [controlId, valueRef] of controlValues) {
    identifier(controlId, 'invalid_arguments');
    identifier(valueRef, 'invalid_arguments');
    if (!grants.has(valueRef)) throw new BrowserBoundaryError('invalid_browser_input');
    controls.set(controlId, valueRef);
  }
  return Object.freeze({
    async check(raw: BrowserMutation) {
      const request = browserMutation(raw), grant = grants.get(request.valueRef);
      if (!grant || grant.kind !== request.kind || controls.get(request.controlId) !== request.valueRef) {
        return { authorized: false, requestFingerprint: requestFingerprint(request) };
      }
      return workflow.checkBrowserAuthority(request, grant);
    },
  });
}
