import { ReplayError } from '../qa-replay/contracts.js';
import { companionLab } from '../qa-replay/companion-lab.js';

try {
  const [action, body, ...extra] = process.argv.slice(2);
  if (!action || !body || extra.length || Buffer.byteLength(body) > 4096) throw new ReplayError('Invalid submission lab request.');
  const result = await companionLab(action, JSON.parse(body) as unknown);
  process.stdout.write(JSON.stringify({ result }) + '\n');
} catch (error) {
  const message = error instanceof ReplayError ? error.message : 'The submission lab is unavailable.';
  process.stdout.write(JSON.stringify({ error: message }) + '\n');
  process.exitCode = 1;
}
