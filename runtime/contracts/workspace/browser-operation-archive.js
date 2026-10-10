import { BrowserBoundaryError } from './browser-boundary.js';
/** Finite immutable retention; terminal operation IDs are never expired or evicted. */
export const browserArchiveSegmentLimit = 32;
export const browserArchiveSegmentCodeUnitLimit = 1024 * 1024 + 128;
export function browserArchiveCheck(value) {
    if (!value)
        throw new BrowserBoundaryError('invalid_browser_state');
}
export function validateBrowserOperationArchiveRoot(value) {
    browserArchiveCheck(value !== null && typeof value === 'object' && !Array.isArray(value));
    const root = value;
    browserArchiveCheck(Object.keys(root).sort().join(',') === 'schemaVersion,segments' && root.schemaVersion === 1
        && Array.isArray(root.segments) && root.segments.length <= browserArchiveSegmentLimit);
    const seen = new Set();
    const segments = [];
    for (const raw of root.segments) {
        browserArchiveCheck(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
        const item = raw;
        browserArchiveCheck(Object.keys(item).sort().join(',') === 'digest,operationCount'
            && typeof item.digest === 'string' && /^[a-f0-9]{64}$/.test(item.digest) && !seen.has(item.digest)
            && Number.isInteger(item.operationCount) && item.operationCount >= 1
            && item.operationCount <= 64);
        seen.add(item.digest);
        segments.push(Object.freeze({ digest: item.digest, operationCount: item.operationCount }));
    }
    return Object.freeze({ schemaVersion: 1, segments: Object.freeze(segments) });
}
