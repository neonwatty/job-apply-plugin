import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { filesystemEncode } from '../contracts/posix-path-bytes.js';
import { nativeAttemptKeyName, nativeAttemptLockName } from '../store/native-store-layout.js';
import { openPrivateStoreFile } from '../store/private-store-entry.js';
import { AttemptFrameDecoder, attemptFrameLimit } from './attempt-protocol.js';
/**
 * Windows attempt transport.
 *
 * Node cannot set a security descriptor on a named pipe it creates. The default pipe DACL
 * lets every user open it for reading, and any user can create a pipe name first. So each
 * side proves it holds a key that only the Store owner can read before any request bytes
 * move:
 *
 *   client -> broker  nonceC (32 bytes)
 *   broker -> client  HMAC(key, "broker" | nonceC | nonceS) | nonceS
 *   client -> broker  HMAC(key, "client" | nonceC | nonceS) | uint32be size | request frame
 *
 * The broker replaces the key in the private Store each time it starts, while holding the
 * attempt lock. The pipe name derives from the key, so a pipe cannot be created ahead of
 * the broker without reading the Store.
 */
const keyBytes = 32, nonceBytes = 32, proofBytes = 32, lengthBytes = 4;
export const attemptLockPath = (root) => join(root, nativeAttemptLockName);
export function attemptPipePath(root, key) {
    const name = createHash('sha256').update('job-apply-attempt\0').update(key).update(filesystemEncode(root)).digest('hex');
    return `\\\\.\\pipe\\job-apply-attempt-${name.slice(0, 48)}`;
}
/** Broker only, while holding the attempt lock: rotate the key before listening. */
export async function publishAttemptKey(root) {
    const key = randomBytes(keyBytes);
    const handle = await openPrivateStoreFile(join(root, nativeAttemptKeyName), constants.O_RDWR | constants.O_CREAT, 'attempt key must be private and owned');
    try {
        await handle.truncate(0);
        await handle.write(key, 0, key.length, 0);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    return key;
}
export async function readAttemptKey(root) {
    const handle = await openPrivateStoreFile(join(root, nativeAttemptKeyName), constants.O_RDONLY, 'attempt key must be private and owned');
    try {
        const key = await handle.readFile();
        if (key.length !== keyBytes)
            throw new Error('attempt key unavailable');
        return key;
    }
    finally {
        await handle.close();
    }
}
const proof = (key, role, client, broker) => createHmac('sha256', key).update(role).update(client).update(broker).digest();
/** Collect exactly `length` bytes, then pause and return them with any extra bytes. */
function receive(socket, length, pending) {
    return new Promise((resolve, reject) => {
        if (pending.length >= length) {
            resolve([pending.subarray(0, length), pending.subarray(length)]);
            return;
        }
        const bytes = Buffer.alloc(length);
        let used = pending.copy(bytes);
        const detach = () => {
            socket.off('data', data);
            socket.off('end', ended);
            socket.off('close', ended);
            socket.off('error', failed);
        };
        const failed = (error) => { detach(); reject(error); };
        const ended = () => failed(new Error('attempt pipe input incomplete'));
        const data = (chunk) => {
            const copied = chunk.copy(bytes, used);
            used += copied;
            if (used < length)
                return;
            detach();
            socket.pause();
            resolve([bytes, chunk.subarray(copied)]);
        };
        socket.on('data', data);
        socket.once('end', ended);
        socket.once('close', ended);
        socket.once('error', failed);
        socket.resume();
    });
}
export function encodePipeRequest(frame) {
    const size = Buffer.alloc(lengthBytes);
    size.writeUInt32BE(frame.length);
    return Buffer.concat([size, frame]);
}
/** Read and validate the whole declared request before it can reach the Store. */
export async function readPipeRequest(socket, pending) {
    const [size, body] = await receive(socket, lengthBytes, pending);
    const length = size.readUInt32BE();
    if (length < 1 || length > attemptFrameLimit)
        throw new Error('invalid attempt pipe size');
    const [bytes] = await receive(socket, length, body);
    const request = new AttemptFrameDecoder().push(bytes);
    if (!request)
        throw new Error('attempt frame incomplete');
    return request;
}
/** Broker side. Resolves with request bytes that followed the client's proof. */
export async function acceptPipeClient(socket, key) {
    const [client, afterNonce] = await receive(socket, nonceBytes, Buffer.alloc(0));
    const broker = randomBytes(nonceBytes);
    socket.write(Buffer.concat([proof(key, 'broker', client, broker), broker]));
    const [presented, rest] = await receive(socket, proofBytes, afterNonce);
    if (!timingSafeEqual(presented, proof(key, 'client', client, broker)))
        throw new Error('attempt client rejected');
    return rest;
}
/** Client side. Resolves once the broker has proven it holds the key. */
export async function connectPipeBroker(socket, key) {
    const client = randomBytes(nonceBytes);
    socket.write(client);
    const [answer, rest] = await receive(socket, proofBytes + nonceBytes, Buffer.alloc(0));
    const broker = answer.subarray(proofBytes);
    if (rest.length || !timingSafeEqual(answer.subarray(0, proofBytes), proof(key, 'broker', client, broker))) {
        throw new Error('attempt broker rejected');
    }
    return proof(key, 'client', client, broker);
}
