import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function syncDirectory(path: string, flags = constants.O_RDONLY): Promise<void> {
  // Node cannot flush a Windows directory handle. File writers still flush contents.
  if (process.platform === 'win32') return;
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
