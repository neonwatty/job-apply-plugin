// Test-only trusted host simulator. IPC is inherited only by the fixture parent;
// the installed model CLI has no approval command or access to this channel.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [plugin, , root, , artifact] = process.argv.slice(2);
const { createTrustedAttemptHost } = await import(pathToFileURL(join(plugin, 'runtime/integrations/host/trusted-attempt.js')));
const host = createTrustedAttemptHost(root, artifact);
process.on('message', async message => {
  try {
    let result;
    if (message.kind === 'review') result = await host.review(message.event);
    else if (message.kind === 'approve') result = host.approvals.approve(message.binding, message.lifetime);
    else if (message.kind === 'revoke') result = host.approvals.revoke(message.grant);
    else throw Error('unsupported fixture request');
    process.send({ id: message.id, ok: true, result });
  } catch { process.send({ id: message.id, ok: false }); }
});
try { await host.run(); }
finally { process.disconnect(); }
