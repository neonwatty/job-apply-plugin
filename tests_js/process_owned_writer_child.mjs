import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fstatSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [mode, state, identity, behavior = 'graceful'] = process.argv.slice(2);
if (!mode || !state || !identity) process.exit(2);

if (behavior === 'startup-failure') process.exit(3);

const ignore = behavior === 'ignore';
const descendantSource = `
  if (process.argv[1] === 'ignore') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  process.send('ready', () => process.disconnect());
`;
const descendant = spawn(process.execPath, ['-e', descendantSource, behavior], {
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
const descendantExit = once(descendant, 'exit');
process.on('SIGTERM', async () => {
  if (ignore) return;
  // Reap the descendant before the controller observes the graceful leader exit.
  await descendantExit;
  if (behavior === 'slow') setTimeout(() => process.exit(0), 250);
  else process.exit(0);
});
await once(descendant, 'message');
await writeFile(join(state, `${identity}.json`), JSON.stringify({
  mode,
  parent: process.pid,
  descendant: descendant.pid,
  ownershipLeaseInherited: fstatSync(3).isFile(),
}));
console.log(JSON.stringify({ mode, identity }));

setInterval(() => {}, 1000);
