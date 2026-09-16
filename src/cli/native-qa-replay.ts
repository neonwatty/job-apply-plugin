#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cleanup, evaluate, prepare, resolveRoute, transition } from '../qa-replay/coordinator.js';
import { verifyAutoSubmit } from '../qa-replay/auto-submit.js';
import { canonical, ReplayError } from '../qa-replay/contracts.js';

function options(args: string[]): { command: string; values: Map<string, string | true> } {
  const command = args[0]; if (!command || command.startsWith('--')) throw new ReplayError('command is required'); const values = new Map<string, string | true>();
  for (let index = 1; index < args.length; index++) { const key = args[index]!; if (!key.startsWith('--') || values.has(key)) throw new ReplayError('invalid command arguments');
    if (key === '--json') values.set(key, true); else { const value = args[++index]; if (!value || value.startsWith('--')) throw new ReplayError('invalid command arguments'); values.set(key, value); } }
  return { command, values };
}
function required(values: Map<string, string | true>, key: string): string { const value = values.get(key); if (typeof value !== 'string') throw new ReplayError(`required option: ${key}`); return value; }
export async function runReplayCli(args: string[]): Promise<{ output: Record<string, unknown>; exitCode: number }> {
  const parsed = options(args), allowed: Record<string, string[]> = { prepare: ['--fixture', '--scenario'], evaluate: ['--run-id'], started: ['--run-id'], reviewed: ['--run-id'],
    resolve: ['--route-token'], cleanup: ['--run-id'], 'verify-auto-submit': ['--fixture', '--json'] };
  const fields = allowed[parsed.command]; if (!fields || [...parsed.values.keys()].some(key => !fields.includes(key))) throw new ReplayError('invalid command arguments');
  if (parsed.command === 'prepare') return { output: await prepare(required(parsed.values, '--fixture'), required(parsed.values, '--scenario')), exitCode: 0 };
  if (parsed.command === 'evaluate') { const result = await evaluate(required(parsed.values, '--run-id')); return { output: result.report, exitCode: result.code }; }
  if (parsed.command === 'started' || parsed.command === 'reviewed') return { output: await transition(required(parsed.values, '--run-id'), parsed.command), exitCode: 0 };
  if (parsed.command === 'resolve') return { output: await resolveRoute(required(parsed.values, '--route-token')), exitCode: 0 };
  if (parsed.command === 'cleanup') return { output: await cleanup(required(parsed.values, '--run-id')), exitCode: 0 };
  const output = await verifyAutoSubmit(required(parsed.values, '--fixture')); return { output, exitCode: output.status === 'passed' ? 0 : 1 };
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try { const result = await runReplayCli(process.argv.slice(2)); process.stdout.write(`${canonical(result.output)}\n`); process.exitCode = result.exitCode; }
  catch (error) { process.stderr.write(`${error instanceof ReplayError ? error.message : 'replay coordinator failed'}\n`); process.exitCode = 2; }
}
