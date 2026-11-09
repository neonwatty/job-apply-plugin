import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeTimestamps } from '../tools/build-native-timestamps.mjs';

export async function timestampFixture() {
  const root = await mkdtemp(join(tmpdir(), 'job-apply-timestamp-'));
  try {
    const receipt = await buildNativeTimestamps({ outputDirectory: join(root, 'addon') });
    return { root, receipt, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function splitNs(value) {
  let seconds = value / 1000000000n;
  let remainder = value % 1000000000n;
  if (remainder < 0n) { seconds -= 1n; remainder += 1000000000n; }
  return [seconds, Number(remainder)];
}
