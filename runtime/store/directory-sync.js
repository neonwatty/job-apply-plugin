import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
export async function syncDirectory(path, flags = constants.O_RDONLY) {
    const handle = await open(path, flags);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
