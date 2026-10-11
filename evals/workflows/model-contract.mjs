/** Closed proposal surface. The controller alone holds fixture paths and host approvals. */
export const modelTools = Object.freeze(['context', 'event', 'observe', 'execute', 'reconcile']);
export const proposalSchema = {
  type: 'object', additionalProperties: false, required: ['message', 'action'],
  properties: {
    message: { type: 'string' },
    action: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
      required: ['id', 'name', 'argumentsJson'], properties: {
        id: { type: 'string' }, name: { type: 'string', enum: modelTools }, argumentsJson: { type: 'string' },
      } }] },
  },
};
export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw Error('Invalid evaluation shape');
}
export function jsonSnapshot(value, maxBytes = 131072) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw Error('Evaluation payload exceeds limit');
  return JSON.parse(text);
}
export function parseProposal(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 131072) throw Error('Invalid model proposal');
  const value = JSON.parse(text);
  exact(value, ['message', 'action']);
  if (typeof value.message !== 'string' || value.message.length > 32768) throw Error('Invalid model message');
  if (value.action === null) return value;
  exact(value.action, ['id', 'name', 'argumentsJson']);
  const { id, name, argumentsJson } = value.action;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)
    || !modelTools.includes(name) || typeof argumentsJson !== 'string') throw Error('Invalid model action');
  const args = JSON.parse(argumentsJson);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid model arguments');
  if (name === 'context') {
    exact(args, Object.hasOwn(args, 'jobId') ? ['jobId'] : []);
    if (Object.hasOwn(args, 'jobId') && (typeof args.jobId !== 'string' || !args.jobId.length)) throw Error('Invalid job identity');
  } else if (name === 'reconcile') {
    exact(args, ['binding', 'operationId']);
    if (typeof args.operationId !== 'string' || !args.operationId.length) throw Error('Invalid operation identity');
  }
  return { message: value.message, action: { id, name, arguments: args } };
}
export async function dispatchModelAction(model, action) {
  if (!modelTools.includes(action.name) || typeof model[action.name] !== 'function') throw Error('Model channel unavailable');
  const args = jsonSnapshot(action.arguments);
  if (action.name === 'context') return model.context(args.jobId);
  if (action.name === 'reconcile') return model.reconcile(args.binding, args.operationId);
  return model[action.name](args);
}

/** A trusted transport must establish these facts before any live inference. */
export function requireIsolation(probe) {
  exact(probe, ['kind', 'evidence', 'checks']);
  exact(probe.checks, ['noModelComputerTools', 'noModelStoreAccess', 'noModelApprovalAccess', 'noModelNetworkTools']);
  if (probe.kind !== 'isolated_json_proposals' || typeof probe.evidence !== 'string' || !probe.evidence.length
    || Object.values(probe.checks).some(value => value !== true)) throw Error('Live model isolation unavailable');
  return jsonSnapshot(probe);
}
