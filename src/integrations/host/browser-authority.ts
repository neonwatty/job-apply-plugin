import { browserBinding, browserMutation, BrowserBoundaryError, requestFingerprint, sameBinding } from '../../contracts/workspace/browser-boundary.js';
import type { BrowserAuthority, BrowserBinding, BrowserMutation } from '../../contracts/workspace/browser-boundary.js';
import { browserValueGrant, browserValueGrantFingerprint } from '../../contracts/workspace/browser-authority.js';
import type { BrowserValueGrant } from '../../contracts/workspace/browser-authority.js';
import { identifier } from '../../harness/validation.js';

export interface WorkflowBrowserAuthorityPort {
  checkBrowserAuthority(request: BrowserMutation, grant: BrowserValueGrant):
    Promise<{ authorized: boolean; requestFingerprint: string }>;
  checkBrowserReconciliationAuthority?(request: BrowserMutation, grant: BrowserValueGrant, binding: BrowserBinding):
    Promise<{ authorized: boolean; requestFingerprint: string }>;
}

/** Trusted configuration maps opaque references to canonical sources, never model classifications. */
export function createBrowserAuthority(workflow: WorkflowBrowserAuthorityPort,
  incoming: ReadonlyMap<string, BrowserValueGrant>, controlValues: ReadonlyMap<string, string>): BrowserAuthority & { bind(request: BrowserMutation): BrowserMutation } {
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
  const check = async (raw: BrowserMutation, current?: BrowserBinding) => {
    const request = browserMutation(raw), grant = grants.get(request.valueRef);
    const denied = { authorized: false, requestFingerprint: requestFingerprint(request) };
    if (!grant || grant.kind !== request.kind || controls.get(request.controlId) !== request.valueRef
      || request.sourceGrantFingerprint !== browserValueGrantFingerprint(grant)) return denied;
    if (current) {
      const binding = browserBinding(current);
      if (workflow.checkBrowserReconciliationAuthority) return workflow.checkBrowserReconciliationAuthority(request, grant, binding);
      if (!sameBinding(binding, request.scope)) return denied;
    }
    return workflow.checkBrowserAuthority(request, grant);
  };
  return Object.freeze({
    bind(raw: BrowserMutation): BrowserMutation {
      const request = browserMutation(raw), grant = grants.get(request.valueRef);
      if (!grant || grant.kind !== request.kind || controls.get(request.controlId) !== request.valueRef) {
        throw new BrowserBoundaryError('authority_denied');
      }
      const sourceGrantFingerprint = browserValueGrantFingerprint(grant);
      if (request.sourceGrantFingerprint && request.sourceGrantFingerprint !== sourceGrantFingerprint) {
        throw new BrowserBoundaryError('authority_denied');
      }
      return browserMutation({ ...request, sourceGrantFingerprint });
    },
    check: (raw: BrowserMutation) => check(raw),
    checkReconciliation: (raw: BrowserMutation, binding: BrowserBinding) => check(raw, binding) });
}
