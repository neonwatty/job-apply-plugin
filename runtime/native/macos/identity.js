import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { JobsError } from '../../contracts/workspace/values.js';
const outputLimit = 4096;
async function sha256(path) {
    const hash = createHash('sha256');
    await new Promise((accept, reject) => {
        const input = createReadStream(path);
        input.on('data', chunk => hash.update(chunk));
        input.on('error', reject);
        input.on('end', accept);
    });
    return hash.digest('hex');
}
async function verifyCodeSignature(path) {
    await new Promise((accept, reject) => {
        const child = spawn('/usr/bin/codesign', ['--verify', '--strict', path], {
            stdio: ['ignore', 'pipe', 'pipe'], env: {},
        });
        let outputBytes = 0, settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            error ? reject(error) : accept();
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(new JobsError('native helper signature verification timed out'));
        }, 5000);
        for (const stream of [child.stdout, child.stderr])
            stream.on('data', chunk => {
                outputBytes += chunk.length;
                if (outputBytes > outputLimit) {
                    child.kill('SIGKILL');
                    finish(new JobsError('native helper signature verification failed closed'));
                }
            });
        child.on('error', () => finish(new JobsError('native helper signature verification failed closed')));
        child.on('exit', code => finish(code === 0 && outputBytes === 0
            ? undefined : new JobsError('native helper signature verification failed closed')));
    });
}
export class ReviewedMacOSHelperIdentity {
    path;
    digest;
    device;
    inode;
    constructor(path, digest, device, inode) {
        this.path = path;
        this.digest = digest;
        this.device = device;
        this.inode = inode;
    }
    static async pin(binaryPath) {
        if (process.platform !== 'darwin')
            throw new JobsError('native macOS helper is unavailable on this platform');
        const candidate = resolve(binaryPath), link = await lstat(candidate, { bigint: true });
        const canonical = await realpath(candidate);
        if (link.isSymbolicLink())
            throw new JobsError('native helper identity is invalid');
        const metadata = await stat(canonical, { bigint: true });
        if (!metadata.isFile() || (metadata.mode & 73n) === 0n || (metadata.mode & 18n) !== 0n) {
            throw new JobsError('native helper identity is invalid');
        }
        await verifyCodeSignature(canonical);
        return new ReviewedMacOSHelperIdentity(canonical, await sha256(canonical), metadata.dev, metadata.ino);
    }
    async verifiedPath() {
        const link = await lstat(this.path, { bigint: true });
        const canonical = await realpath(this.path), metadata = await stat(canonical, { bigint: true });
        if (link.isSymbolicLink() || canonical !== this.path || !metadata.isFile()
            || (metadata.mode & 73n) === 0n || (metadata.mode & 18n) !== 0n
            || metadata.dev !== this.device || metadata.ino !== this.inode
            || await sha256(canonical) !== this.digest)
            throw new JobsError('native helper identity is invalid');
        await verifyCodeSignature(canonical);
        return canonical;
    }
}
