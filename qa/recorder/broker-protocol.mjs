import { BrokerError } from './broker-session.mjs';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const KEYS = {
  mkdir: ['path'],
  'write-exclusive': ['path', 'data'],
  'atomic-replace': ['path', 'data'],
  append: ['path', 'data'],
  'remove-tree': ['path'],
  'rename-no-replace': ['source', 'destination'],
  list: ['path'],
  'hash-source-files': [],
  'stat-budget': [],
};
const utf8 = new TextDecoder('utf-8', { fatal: true });

export async function* boundedLines(input, limit = MAX_REQUEST_BYTES) {
  let pieces = [], size = 0, oversized = false;
  for await (const chunk of input) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!oversized) {
        const piece = chunk.subarray(start, end);
        size += piece.length;
        oversized = size + Number(newline >= 0) > limit;
        if (oversized) pieces = [];
        else if (piece.length) pieces.push(piece);
      }
      if (newline < 0) break;
      yield oversized ? null : Buffer.concat(pieces, size);
      pieces = [];
      size = 0;
      oversized = false;
      start = newline + 1;
    }
  }
  if (oversized || size) yield oversized ? null : Buffer.concat(pieces, size);
}

function decodeData(value) {
  if (typeof value !== 'string') throw new BrokerError('invalid-data');
  const data = Buffer.from(value, 'base64');
  if (data.toString('base64') !== value) throw new BrokerError('invalid-data');
  return data;
}

function dispatch(broker, request) {
  const { id, command } = request;
  if (!Number.isSafeInteger(id) || id < 0 || typeof command !== 'string' || !Object.hasOwn(KEYS, command) ||
      Object.keys(request).length !== KEYS[command].length + 2 ||
      !KEYS[command].every(key => Object.hasOwn(request, key))) {
    throw new BrokerError('invalid-request');
  }
  switch (command) {
    case 'mkdir': broker.mkdir(request.path); break;
    case 'write-exclusive': broker.writeExclusive(request.path, decodeData(request.data)); break;
    case 'atomic-replace': broker.atomicReplace(request.path, decodeData(request.data)); break;
    case 'append': broker.append(request.path, decodeData(request.data)); break;
    case 'remove-tree': broker.removeTree(request.path); break;
    case 'rename-no-replace': broker.renameNoReplace(request.source, request.destination); break;
    case 'list': return broker.list(request.path);
    case 'hash-source-files': return broker.hashSourceFiles();
    case 'stat-budget': return broker.budget();
  }
  return null;
}

export function responseFor(broker, raw) {
  if (raw === null) return { id: null, ok: false, code: 'request-budget' };
  let id = null;
  try {
    const request = JSON.parse(utf8.decode(raw));
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new BrokerError('invalid-request');
    if (Number.isSafeInteger(request.id)) id = request.id;
    return { id, ok: true, result: dispatch(broker, request) };
  } catch (error) {
    return { id, ok: false, code: error instanceof BrokerError ? error.message : 'invalid-request' };
  }
}
