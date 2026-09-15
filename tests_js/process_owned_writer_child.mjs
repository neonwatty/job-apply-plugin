import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [mode, state, identity, behavior = 'graceful'] = process.argv.slice(2);
if (!mode || !state || !identity) process.exit(2);

if (behavior === 'startup-failure') process.exit(3);

const ignore = behavior === 'ignore';
const descendantSource = ignore
  ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
  : 'setInterval(()=>{},1000)';
const descendant = spawn(process.execPath, ['-e', descendantSource], {
  stdio: 'ignore',
});
await writeFile(join(state, `${identity}.json`), JSON.stringify({
  mode,
  parent: process.pid,
  descendant: descendant.pid,
  ownershipLeaseInherited: fstatSync(3).isFile(),
}));
console.log(JSON.stringify({ mode, identity }));

if (ignore) process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => setTimeout(() => process.exit(0), behavior === 'slow' ? 250 : 10));
setInterval(() => {}, 1000);
