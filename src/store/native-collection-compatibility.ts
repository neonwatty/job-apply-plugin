import { constants } from 'node:fs';
import { join } from 'node:path';
import { parsePythonPointJsonBytes } from '../contracts/raw-json/point-parser.js';
import { get, has, int, object, JobsError } from '../contracts/workspace/values.js';
import { openPrivateStoreFile } from './private-store-entry.js';

const journalName = 'collection-journal.json';
export const collectionPreviewStoreEntries = [
  'collection.json', journalName, 'autopilot-policy.json', 'autopilot-runs.json', 'autopilot-host.json',
] as const;

/** Preserve preview data under the Store lock. A collection writer must finish its own journal first. */
export async function validateCollectionCompatibility(root: string, entries: ReadonlySet<string>) {
  for (const name of collectionPreviewStoreEntries) {
    if (!entries.has(name)) continue;
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK);
    const file = await openPrivateStoreFile(join(root, name), flags, 'collection preview state is not private');
    try {
      const limit = name === 'collection.json' ? 8 * 1024 * 1024 : 32 * 1024 * 1024;
      if ((await file.stat()).size > limit) throw new JobsError('collection preview state exceeds its capacity');
      if (name !== journalName) continue;
      const journal = object(parsePythonPointJsonBytes(await file.readFile(), {
        diagnosticProfile: '3.12', intMaxStrDigits: 4300,
      }), 'collection journal');
      if (journal.size !== 2 || int(get(journal, 'schemaVersion')) !== 1n || !has(journal, 'operation')) {
        throw new JobsError('collection preview journal is invalid');
      }
      if (get(journal, 'operation') !== null) throw new JobsError('finish the pending collection operation in the collection build first');
    } finally { await file.close(); }
  }
}
