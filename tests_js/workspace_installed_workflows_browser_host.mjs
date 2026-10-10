// Trusted fixture driver only. The inherited IPC channel is unavailable to CLI clients.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [plugin, root, artifact] = process.argv.slice(2);
const moduleAt = path => import(pathToFileURL(join(plugin, 'runtime', path)));
const { createTrustedBrowserWorkflowHost } = await moduleAt('integrations/host/workflow-browser-host.js');
const { SyntheticBrowserAdapter } = await moduleAt('integrations/browser/synthetic.js');
const { controlFingerprint } = await moduleAt('contracts/workspace/browser-boundary.js');
const controls = [{ id: 'other.file', kind: 'upload', state: 'empty' },
  { id: 'resume.file', kind: 'upload', state: 'empty' }, { id: 'submit', kind: 'final', state: 'empty' }];
const adapter = new SyntheticBrowserAdapter({ evidenceKind: 'synthetic_adapter', form: { documentId: 'fictional-document',
  formId: 'fictional-form', origin: 'https://example.invalid', controlSetFingerprint: controlFingerprint(controls) },
  observationRevision: '1', controls, finalAction: 'untouched' }, new Map([['selected-resume', 'Fictional managed resume']]));
let host, failReadback = false;
const wrapped = { evidenceKind: 'synthetic_adapter', observe: () => adapter.observe(),
  mutate: request => adapter.mutate(request), readback: request => {
    if (failReadback) { failReadback = false; throw Error('Fixture readback interruption'); }
    return adapter.readback(request);
  } };
process.on('message', async message => {
  try {
    let result;
    if (message.kind === 'initialize') {
      if (host) throw Error('Already initialized');
      host = createTrustedBrowserWorkflowHost(root, artifact, wrapped, new Map([['selected-resume', message.grant]]), { controls: new Map([['resume.file', 'selected-resume']]) });
      void host.run().then(() => process.disconnect()).catch(() => { process.exitCode = 1; process.disconnect(); });
      result = true;
    } else if (message.kind === 'review') result = await host.review(message.event);
    else if (message.kind === 'approve') result = host.approvals.approve(message.binding, message.lifetime);
    else if (message.kind === 'revoke') result = host.approvals.revoke(message.grant);
    else if (message.kind === 'stats') result = adapter.calls;
    else if (message.kind === 'interrupt-readback') { failReadback = true; result = true; }
    else throw Error('Unsupported fixture command');
    process.send({ id: message.id, ok: true, result });
  } catch { process.send({ id: message.id, ok: false }); }
});
