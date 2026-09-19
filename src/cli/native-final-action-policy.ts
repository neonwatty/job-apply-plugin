#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { FinalActionPolicyService } from '../final-action-policy/service.js';
import { expandRoot } from '../final-action-policy/repository.js';
import { check, decodePolicyBytes, object, parsePolicyJson, PolicyError, serializeDocument } from '../final-action-policy/model.js';

const commands: Record<string, readonly string[]> = {
  status: [], activate: ['input'], authorize: ['input'],
  'claim-final-action': ['input', 'application-ref', 'lease-id', 'attempt', 'action-capability'],
  'record-outcome': ['campaign-id', 'application-ref', 'lease-id', 'claim-id', 'outcome', 'confirmation-event', 'confirmation-capability'],
  kill: [], revoke: [],
};
class PolicyHelp extends Error {
  constructor(readonly usage: string) { super('help requested'); }
}
function policyHelp(command?: string): string {
  const names = Object.keys(commands);
  const optional = new Set(['confirmation-event', 'confirmation-capability']);
  const usage = command
    ? `usage: job-apply-policy ${command} [-h] ${commands[command]!.map(name => {
      const option = `--${name} ${name.toUpperCase().replaceAll('-', '_')}`;
      return optional.has(name) ? `[${option}]` : option;
    }).join(' ')}`.trimEnd()
    : `usage: job-apply-policy [-h] [--root ROOT] {${names.join(',')}}`;
  const options = command ? commands[command]! : ['root'];
  return `${usage}\n\noptions:\n  -h, --help  show this help message and exit\n`
    + options.map(name => `  --${name}\n`).join('');
}
async function readInput(path: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    let text: string;
    if (path === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      text = decodePolicyBytes(Buffer.concat(chunks));
    } else text = decodePolicyBytes(await readFile(expandRoot(path)));
    value = parsePolicyJson(text);
  } catch { throw new PolicyError('input is not a readable JSON object'); }
  return object(value, 'input');
}
export async function runPolicyCli(args: string[]): Promise<unknown> {
  const names = new Set(['root', ...Object.values(commands).flat()]);
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true,
      options: { ...Object.fromEntries([...names].map(name => [name, { type: 'string' as const }])),
        help: { type: 'boolean', short: 'h' } } });
  } catch { throw new PolicyError('command arguments are invalid'); }
  if (parsed.values.help === true && parsed.positionals.length <= 1) {
    const selected = parsed.positionals[0];
    if (selected === undefined || Object.hasOwn(commands, selected)) throw new PolicyHelp(policyHelp(selected));
  }
  check(parsed.positionals.length === 1, 'command arguments are invalid');
  const command = parsed.positionals[0]!;
  check(Object.hasOwn(commands, command), 'unsupported command');
  const allowed = new Set(['root', ...commands[command]!]);
  check(Object.keys(parsed.values).every(name => allowed.has(name)), 'command arguments are invalid');
  const get = (name: string): string | undefined => typeof parsed.values[name] === 'string' ? parsed.values[name] : undefined;
  const required = (name: string): string => {
    const value = get(name);
    check(value, 'required command argument is missing');
    return value;
  };
  const optional = new Set(['confirmation-event', 'confirmation-capability']);
  for (const name of commands[command]!) if (!optional.has(name)) required(name);
  const configured = get('root') || process.env.JOB_APPLY_STORE_DIR;
  const root = configured ? expandRoot(configured) : join(homedir(), '.job-apply');
  const pluginRoot = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  const provider = loadPosixFlockProvider(await resolvePackagedNativeLock(pluginRoot));
  const service = new FinalActionPolicyService(root, { provider });
  if (command === 'status') return service.status();
  if (command === 'activate') return service.activate(await readInput(required('input')));
  if (command === 'authorize') return service.authorize(await readInput(required('input')));
  if (command === 'claim-final-action') {
    const ordinal = required('attempt');
    check(/^[+-]?\d+$/.test(ordinal), 'attempt ordinal is invalid');
    return service.claim(required('application-ref'), required('lease-id'), Number(ordinal), await readInput(required('input')), required('action-capability'));
  }
  if (command === 'record-outcome') {
    const eventPath = get('confirmation-event');
    return service.outcome(required('campaign-id'), required('application-ref'), required('lease-id'), required('claim-id'), required('outcome'),
      eventPath ? await readInput(eventPath) : undefined, get('confirmation-capability'));
  }
  if (command === 'kill') return service.kill();
  return service.revoke();
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(serializeDocument(await runPolicyCli(process.argv.slice(2)))); }
  catch (error) {
    if (error instanceof PolicyHelp) {
      process.stdout.write(error.usage);
      process.exitCode = 0;
    } else {
      process.stderr.write(`job-apply-policy: ${error instanceof PolicyError ? error.message : 'policy operation failed'}\n`);
      process.exitCode = 2;
    }
  }
}
