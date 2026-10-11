import { createInterface } from 'node:readline';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { LocalFixtureBrowserAdapter } from '../runtime/integrations/browser/local-fixture-adapter.js';
import { BrowserWorkflowBroker } from '../runtime/integrations/host/browser-workflow-broker.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { host } from './workspace_host_browser_support.mjs';

// stdin/stdout carry only model proposals. The fork's private IPC channel carries
// fixture configuration, trusted user approval, and a closed browser page port.
const pending = new Map();
let nextPageRequest = 0;
let ports;
let broker;
function pageCall(method, args) {
  const id = ++nextPageRequest;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ channel: 'page', id, method, args });
  });
}
process.on('message', async message => {
  try {
    if (message.channel === 'page-result') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
      return;
    }
    if (message.channel === 'initialize') {
      const provider = loadPosixFlockProvider(message.artifact);
      const repository = new NativeJobsRepository(message.root, provider);
      const clock = { now: message.now };
      const state = { repository, clock, claims: new ClaimsService(repository, () => clock.now),
        grants: new Map([['profile.name', { kind: 'fill', source: 'profile', field: 'name', profileRevision: '1' }]]) };
      const page = {
        observe: () => pageCall('observe', []),
        compareAndFill: input => pageCall('compareAndFill', [input]),
        readback: (controlId, value) => pageCall('readback', [controlId, value]),
      };
      const adapter = new LocalFixtureBrowserAdapter(page, message.origin,
        new Map([['contact.name', { valueRef: 'profile.name', value: 'UNRELATED PRIVATE PROFILE' }]]));
      ports = host(state, { adapter, controls: new Map([['contact.name', 'profile.name']]) });
      broker = new BrowserWorkflowBroker(ports, () => process.exit(2));
      process.send({ channel: 'initialized' });
      return;
    }
    if (message.channel === 'approve') {
      const review = await ports.host.review(message.event);
      ports.host.approvals.approve(review.binding, 300000);
      process.send({ channel: 'approval', id: message.id });
      return;
    }
    throw Error('unknown_private_channel');
  } catch (error) {
    process.send({ channel: 'private-error', id: message.id, error: String(error.message) });
  }
});
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  try {
    const result = await broker.dispatch(fromJSON(request.proposal));
    process.stdout.write(JSON.stringify({ id: request.id, result: JSON.parse(serialize(result.response)).result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request.id, error: String(error.message) }) + '\n');
  }
}
await broker?.close();
process.disconnect();
