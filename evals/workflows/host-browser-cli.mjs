import { readFile } from 'node:fs/promises';
import { createHostBrowserFixture } from './host-browser-fixture.mjs';
const args = process.argv.slice(2), action = args.shift();
function option(name) { const index = args.indexOf('--' + name); return index < 0 ? undefined : args[index + 1]; }
try {
  if (action === 'start') {
    if (!option('output') || !option('scenario')) throw Error('start requires --output and --scenario');
    const fixture = await createHostBrowserFixture({ outputDirectory: option('output'), scenario: option('scenario') });
    process.stdout.write(JSON.stringify(fixture.manifest) + '\n');
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => fixture.close().then(() => process.exit(0)).catch(error => { process.stderr.write(error.message + '\n'); process.exit(1); }));
  } else {
    if (!['inspect', 'grade', 'stop', 'command', 'checkpoint', 'inject', 'authorized-event'].includes(action) || !option('manifest')) throw Error('Unknown command or missing --manifest');
    const manifest = JSON.parse(await readFile(option('manifest'), 'utf8'));
    const url = new URL(manifest.url);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/') throw Error('Invalid loopback manifest');
    let payload;
    if (action === 'command') {
      payload = { command: option('command'), kind: option('kind') ?? 'canonical' };
      if (option('input')) payload.payload = JSON.parse(await readFile(option('input'), 'utf8'));
    }
    if (action === 'authorized-event') {
      if (!option('input')) throw Error('authorized-event requires --input');
      payload = JSON.parse(await readFile(option('input'), 'utf8'));
    }
    if (action === 'checkpoint') payload = option('input') ? JSON.parse(await readFile(option('input'), 'utf8')) : { kind: option('kind') };
    if (action === 'inject') payload = option('kind') === 'source-input-drift' ? { kind: option('kind') } : { kind: option('kind'), signal: option('signal') ?? 'SIGKILL' };
    const response = await fetch(new URL(action, url), { method: 'POST', headers: { authorization: `Bearer ${manifest.token}`, 'content-type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!response.ok) process.exitCode = 1;
  }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
