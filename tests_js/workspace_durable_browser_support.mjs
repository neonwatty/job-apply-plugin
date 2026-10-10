import { DurableBrowserBoundary } from '../runtime/integrations/browser/durable-boundary.js';
import { SyntheticBrowserAdapter } from '../runtime/integrations/browser/synthetic.js';
import { controlFingerprint, requestFingerprint } from '../runtime/integrations/browser/contract.js';
import { emptyBrowserOperationLedger, validateBrowserOperationLedger,
  validateBrowserOperationTransition } from '../runtime/contracts/workspace/browser-operations.js';
export const binding = { taskId: 'task-fictional', taskRevision: '9007199254740993', jobId: 'job-fictional',
  attemptRevision: '3', authorizationRevision: '2' };
export function observation() {
  const controls = [{ id: 'contact.email', kind: 'fill', state: 'empty' },
    { id: 'resume.file', kind: 'upload', state: 'empty' }, { id: 'submit', kind: 'final', state: 'empty' }];
  return { evidenceKind: 'synthetic_adapter', form: { documentId: 'document-fictional', formId: 'form-fictional',
    origin: 'https://fixture.invalid', controlSetFingerprint: controlFingerprint(controls) },
  observationRevision: '1', controls, finalAction: 'untouched' };
}
export const adapter = () => new SyntheticBrowserAdapter(observation(), new Map([
  ['profile.email', 'PRIVATE-FICTIONAL-EMAIL'], ['resume.selected', 'PRIVATE-FICTIONAL-RESUME'],
]));
export const allow = { check: async request => ({ authorized: true, requestFingerprint: requestFingerprint(request) }) };
export const mutation = (observed, overrides = {}) => ({ operationId: 'operation-one', scope: { ...binding,
  form: observed.form, observationRevision: observed.observationRevision }, kind: 'fill',
  controlId: 'contact.email', valueRef: 'profile.email', ...overrides });
export const wrapper = (base, overrides) => ({ evidenceKind: 'synthetic_adapter', observe: () => base.observe(),
  mutate: request => base.mutate(request), readback: request => base.readback(request), ...overrides });
export const boundary = (store, base, authority = allow) => new DurableBrowserBoundary(base, authority, binding, store);
export function memoryStore(initial = emptyBrowserOperationLedger(), hook = async () => {}) {
  let ledger = validateBrowserOperationLedger(initial), queue = Promise.resolve(), commits = 0;
  return {
    get ledger() { return ledger; }, get commits() { return commits; },
    transaction(operation) {
      const result = queue.then(() => operation({ ledger, commit: async next => {
        validateBrowserOperationTransition(ledger, next);
        await hook('before', next);
        ledger = validateBrowserOperationLedger(next);
        commits++;
        await hook('after', next);
      } }));
      queue = result.then(() => {}, () => {});
      return result;
    },
  };
}
