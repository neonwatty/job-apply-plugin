import { lstat, readFile } from 'node:fs/promises';

export class ReplayError extends Error {}

export type Control = { id: string; kind: string; role: string; label: string; required: boolean; choices?: string[] };
export type Step = { id: string; kind: 'form' | 'review'; title: string; controls: Control[]; next?: string;
  finalAction?: { id: string; label: string; enabled: boolean; tripwire: boolean } };
export type Fixture = { schemaVersion: number; id: string; platformFamily: string; steps: Step[]; oracle: { finalActionActivations: number }; [key: string]: unknown };
export type RunState = { fixtureId: string; scenarioId: string; url: string; storeRoot: string; fixturePath: string;
  routeToken: string; shutdownToken: string; lifecycleNonce: string; createdAt: string };
export type ReplayEvent = Record<string, unknown>;

export const scenarios = new Set(['ashby-complete-profile', 'complete-profile', 'greenhouse-complete-profile', 'lever-complete-profile', 'linkedin-screening']);
export const platforms: Record<string, string> = { ashby: 'Ashby', greenhouse: 'Greenhouse', lever: 'Lever',
  'linkedin-easy-apply': 'LinkedIn Easy Apply' };
export const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const runIdentifier = /^qa-run-20[0-9]{6}-[a-f0-9]{8}$/;
export const token = /^[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validateFixture(value: unknown): Fixture {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !identifier.test(value.id)
    || typeof value.platformFamily !== 'string' || !record(value.oracle) || value.oracle.finalActionActivations !== 0
    || !Array.isArray(value.steps) || value.steps.length < 1) throw new ReplayError('invalid fixture package');
  const ids = new Set<string>(), controls = new Set<string>();
  for (const raw of value.steps) {
    if (!record(raw) || typeof raw.id !== 'string' || !identifier.test(raw.id) || ids.has(raw.id)
      || !['form', 'review'].includes(String(raw.kind)) || typeof raw.title !== 'string' || !Array.isArray(raw.controls)) throw new ReplayError('invalid fixture package');
    ids.add(raw.id);
    for (const item of raw.controls) {
      if (!record(item) || typeof item.id !== 'string' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(item.id) || controls.has(item.id)
        || typeof item.kind !== 'string' || typeof item.role !== 'string' || typeof item.label !== 'string' || typeof item.required !== 'boolean') throw new ReplayError('invalid fixture package');
      controls.add(item.id);
    }
  }
  if (value.steps.filter(raw => record(raw) && raw.kind === 'review').length !== 1) throw new ReplayError('invalid fixture package');
  return value as Fixture;
}
export async function readJson(path: string, diagnostic: string, limit = 1024 * 1024): Promise<unknown> {
  try {
    const info = await lstat(path, { bigint: false });
    if (!info.isFile() || info.size > limit) throw new Error();
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch { throw new ReplayError(diagnostic); }
}
export function validateState(value: unknown, runId: string, runRoot: string): RunState {
  const keys = ['fixtureId', 'scenarioId', 'url', 'storeRoot', 'fixturePath', 'routeToken', 'shutdownToken', 'lifecycleNonce', 'createdAt'];
  if (!record(value) || !exact(value, keys) || keys.some(key => typeof value[key] !== 'string') || !identifier.test(String(value.fixtureId))
    || !scenarios.has(String(value.scenarioId)) || !token.test(String(value.routeToken)) || !token.test(String(value.shutdownToken))
    || !token.test(String(value.lifecycleNonce)) || !runIdentifier.test(runId)
    || value.storeRoot !== `${runRoot}/store` || value.fixturePath !== `${runRoot}/fixture.json`) throw new ReplayError('invalid run state');
  return value as RunState;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
