import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export async function requiredEnvironment(base = process.env) {
  const directory = await mkdtemp(join(tmpdir(), 'job-apply-no-python-'));
  for (const name of ['python', 'python3', 'python3.12', 'python3.13', 'python3.14', 'pypy', 'pypy3', 'uv']) {
    await writeFile(join(directory, name), '#!/bin/sh\necho "CPython is disabled in required TypeScript validation" >&2\nexit 86\n', { mode: 0o755 });
  }
  const guard = new URL('./no-python.mjs', import.meta.url).href;
  return {
    environment: { ...base, PATH: `${directory}${delimiter}${base.PATH ?? ''}`,
      NODE_OPTIONS: `${base.NODE_OPTIONS ?? ''} --import=${guard}`.trim(), NEXT_TELEMETRY_DISABLED: '1' },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
