import { JobsError } from './values.js';
export function decodeAnswerKey(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1)
        throw new JobsError('encoded answer key is invalid');
    try {
        const result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(value, 'base64url'));
        if (!result)
            throw new Error();
        return result;
    }
    catch {
        throw new JobsError('encoded answer key is invalid');
    }
}
