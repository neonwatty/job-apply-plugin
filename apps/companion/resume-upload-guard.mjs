#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const command = join(dirname(fileURLToPath(import.meta.url)), 'command.mjs');

export class UploadGuardError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function parseUploadGuardArgs(args) {
  const allowed = new Set(['--id', '--expected-revision', '--candidate-path', '--root']);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || options.has(key) || !value || value.startsWith('--')) {
      throw new UploadGuardError('invalid_invocation');
    }
    options.set(key, value);
  }
  const id = options.get('--id'), revision = options.get('--expected-revision');
  const candidate = options.get('--candidate-path');
  if (!id || !/^[1-9][0-9]*$/.test(revision ?? '') || !candidate || !isAbsolute(candidate)) {
    throw new UploadGuardError('invalid_invocation');
  }
  return { id, revision, candidate, root: options.get('--root') };
}

/** Require exact bytes for the chooser path; never normalize an agent-supplied guess. */
export async function verifyResumeUploadPath(resolved, { id, revision, candidate }) {
  if (resolved?.id !== id || String(resolved?.revision) !== revision
    || typeof resolved?.path !== 'string' || !isAbsolute(resolved.path)
    || candidate !== resolved.path) throw new UploadGuardError('path_mismatch');
  let file;
  try {
    file = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size < 1) throw new Error('invalid file');
  } catch { throw new UploadGuardError('file_unavailable'); }
  finally { await file?.close(); }
  return { ok: true, id, revision: resolved.revision, path: resolved.path };
}

async function resolveResume({ id, root }) {
  try {
    const args = [command, 'store', ...(root ? ['--root', root] : []), 'resume-resolve', '--id', id];
    const { stdout } = await execute(process.execPath, args, { timeout: 15000, maxBuffer: 16384 });
    return JSON.parse(stdout);
  } catch { throw new UploadGuardError('store_unavailable'); }
}

export async function runUploadGuard(args, resolver = resolveResume) {
  const options = parseUploadGuardArgs(args);
  return verifyResumeUploadPath(await resolver(options), options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.stdout.write(JSON.stringify(await runUploadGuard(process.argv.slice(2))) + '\n'); }
  catch (error) {
    const code = error instanceof UploadGuardError ? error.code : 'guard_unavailable';
    process.stdout.write(JSON.stringify({ ok: false, error: { code } }) + '\n');
    process.exitCode = 2;
  }
}
