import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
export async function boundedFile(path, limit) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > limit)
            throw new Error('invalid input');
        // A bounded read also handles growth between stat and read without allocating arbitrary input.
        const bytes = Buffer.alloc(limit + 1);
        let size = 0;
        while (size <= limit) {
            const result = await handle.read(bytes, size, bytes.length - size, null);
            if (!result.bytesRead)
                break;
            size += result.bytesRead;
            if (size > limit)
                throw new Error('invalid input');
        }
        return bytes.subarray(0, size).toString('utf8');
    }
    finally {
        await handle.close();
    }
}
