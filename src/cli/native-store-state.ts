import { basename } from 'node:path';
import { copy, get, keys, object, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { HistoryService } from '../workspace-core/store-history.js';
import type { HistoryRepository } from '../workspace-core/store-history.js';
import { SessionService } from '../workspace-core/store-sessions.js';
import type { SessionRepository } from '../workspace-core/store-sessions.js';
import { PreparednessService } from '../workspace-core/profile-preparedness.js';
import type { PreparednessRepository } from '../workspace-core/profile-preparedness.js';

export const nativeStoreStateCommandNames = new Set([
  'history-append', 'history-list', 'profile-preparedness-get', 'resume-create',
  'session-save', 'session-load', 'session-list', 'session-delete',
]);
type Repository = HistoryRepository & SessionRepository & PreparednessRepository & {
  resumeImport(metadata: Value, filename: string, content: Buffer, preserveFilename: boolean): Promise<Document>;
};
export interface NativeStoreStateCommandContext {
  repository: Repository;
  readInput(path: string): Promise<Value>;
  readResumePath?(path: string): Promise<Buffer>;
}
const specifications: Record<string, { allowed: string[]; required: string[] }> = {
  'history-append': { allowed: ['--input'], required: ['--input'] },
  'history-list': { allowed: [], required: [] },
  'profile-preparedness-get': { allowed: [], required: [] },
  'resume-create': { allowed: ['--input'], required: ['--input'] },
  'session-save': { allowed: ['--id', '--input'], required: ['--id', '--input'] },
  'session-load': { allowed: ['--id'], required: ['--id'] },
  'session-list': { allowed: [], required: [] },
  'session-delete': { allowed: ['--id'], required: ['--id'] },
};
function optionsFor(command: string, args: string[]): Map<string, string> {
  const specification = specifications[command]!, options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (!key.startsWith('--')) throw new JobsError('unexpected CLI argument');
    if (options.has(key)) throw new JobsError('duplicate CLI option');
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new JobsError('missing CLI option value');
    options.set(key, value);
  }
  if ([...options.keys()].some(key => !specification.allowed.includes(key))) throw new JobsError('unsupported native Store state command or option');
  for (const key of specification.required) if (!options.has(key)) throw new JobsError(`required option: ${key}`);
  return options;
}
async function input(context: NativeStoreStateCommandContext, path: string): Promise<Value> {
  try { return await context.readInput(path); }
  catch { throw new JobsError('input is not a readable JSON object'); }
}
function withoutPath(payload: Value): { metadata: Document; path: string } {
  const source = object(payload, 'resume input'), path = string(get(source, 'path'));
  if (path === null) throw new JobsError('resume path must be a string');
  const metadata = copy(source); metadata.delete(text('path'));
  if (keys(metadata).some(key => !['id', 'label', 'tags', 'default'].includes(key))) throw new JobsError('resume input contains unsupported fields');
  return { metadata, path };
}
export async function runNativeStoreStateCommand(command: string, args: string[],
  context: NativeStoreStateCommandContext): Promise<Value | null> {
  if (!nativeStoreStateCommandNames.has(command)) return null;
  const options = optionsFor(command, args), required = (key: string): string => options.get(key)!;
  const history = new HistoryService(context.repository), sessions = new SessionService(context.repository);
  switch (command) {
    case 'history-append': return history.append(await input(context, required('--input')));
    case 'history-list': return history.list();
    case 'profile-preparedness-get': return new PreparednessService(context.repository).get();
    case 'session-save': return sessions.save(required('--id'), await input(context, required('--input')));
    case 'session-load': return sessions.load(required('--id'));
    case 'session-list': return sessions.list();
    case 'session-delete': return sessions.delete(required('--id'));
    case 'resume-create': {
      const { metadata, path } = withoutPath(await input(context, required('--input')));
      if (!context.readResumePath) throw new JobsError('native resume path reader is required');
      return context.repository.resumeImport(metadata, basename(path), await context.readResumePath(path), true);
    }
    default: return null;
  }
}
