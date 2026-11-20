import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export async function syncDirectory(path: string, flags = constants.O_RDONLY): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
