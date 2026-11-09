import { constants, read, fstat, close } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { parseLegacyJobReport } from '../contracts/workspace/legacy-job-report.js';
import { fromJSON, object, set, JobsError } from '../contracts/workspace/values.js';
const rootName = '.claude-job-searches';
const maxFile = 2 * 1024 * 1024;
const statDescriptor = promisify(fstat), closeDescriptor = promisify(close), readDescriptor = promisify(read);
const fail = (message) => { throw new JobsError(message); };
async function report(provider, root, name, metadata) {
    let descriptor;
    try {
        descriptor = provider.openFile(root, name);
    }
    catch {
        return fail('legacy search report cannot be opened safely');
    }
    try {
        const opened = await statDescriptor(descriptor, { bigint: true });
        if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) {
            return fail('legacy search report changed during discovery');
        }
        const chunks = [];
        let total = 0;
        while (true) {
            const buffer = Buffer.alloc(Math.min(65536, maxFile + 1 - total));
            const { bytesRead } = await readDescriptor(descriptor, buffer, 0, buffer.length, null);
            if (!bytesRead)
                break;
            total += bytesRead;
            if (total > maxFile)
                return fail('legacy search report exceeds the per-file byte limit');
            chunks.push(buffer.subarray(0, bytesRead));
        }
        if ((await statDescriptor(descriptor, { bigint: true })).size !== opened.size)
            return fail('legacy search report changed during discovery');
        return Buffer.concat(chunks);
    }
    finally {
        await closeDescriptor(descriptor);
    }
}
/** All entry inspection and opens resolve against the pinned directory, never a replaced path. */
export async function discoverLegacyJobs(home, provider) {
    const root = join(home, rootName);
    const result = object(fromJSON({ root: `~/${rootName}`, manifest: [], items: [] }), 'legacy discovery');
    let metadata;
    try {
        metadata = await lstat(root, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return result;
        return fail('legacy search root cannot be inspected');
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        return fail('legacy search root must be a regular directory');
    let handle;
    try {
        handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    }
    catch {
        return fail('legacy search root cannot be opened safely');
    }
    try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isDirectory() || opened.dev !== metadata.dev || opened.ino !== metadata.ino)
            return fail('legacy search root changed during discovery');
        // Python sorts Unicode code points rather than UTF-16 code units.
        const names = provider.listNames(handle.fd)
            .filter(name => name.subarray(0, 7).equals(Buffer.from('search-')) && name.subarray(-3).equals(Buffer.from('.md')))
            .map(name => {
            try {
                return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(name);
            }
            catch {
                return fail('legacy search report name is not valid UTF-8');
            }
        });
        names.sort((a, b) => {
            const left = Array.from(a, c => c.codePointAt(0)), right = Array.from(b, c => c.codePointAt(0));
            for (let i = 0; i < Math.min(left.length, right.length); i++)
                if (left[i] !== right[i])
                    return left[i] - right[i];
            return left.length - right.length;
        });
        if (names.length > 100)
            return fail('legacy search discovery exceeds the file limit');
        const manifest = [], items = [];
        let aggregate = 0n;
        for (const name of names) {
            let entry;
            try {
                entry = provider.inspect(handle.fd, name);
            }
            catch {
                return fail('legacy search report cannot be inspected');
            }
            if ((entry.mode & constants.S_IFMT) !== constants.S_IFREG)
                return fail('legacy search reports must be regular files');
            if (entry.size > BigInt(maxFile))
                return fail('legacy search report exceeds the per-file byte limit');
            aggregate += entry.size;
            if (aggregate > 20n * 1024n * 1024n)
                return fail('legacy search discovery exceeds the aggregate byte limit');
            const raw = await report(provider, handle.fd, name, entry);
            let decoded;
            try {
                decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
            }
            catch {
                return fail('legacy search report is not valid UTF-8');
            }
            const digest = createHash('sha256').update(raw).digest('hex');
            manifest.push(object(fromJSON({ relativePath: name, sourceSha256: digest, size: raw.length }), 'legacy manifest'));
            items.push(...parseLegacyJobReport(name, digest, decoded));
            if (items.length > 5000)
                return fail('legacy search discovery exceeds the entry limit');
        }
        set(result, 'manifest', manifest);
        set(result, 'items', items);
        return result;
    }
    finally {
        await handle.close();
    }
}
