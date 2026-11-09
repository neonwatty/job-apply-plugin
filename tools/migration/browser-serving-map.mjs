import { createHash } from 'node:crypto';

export const BRIDGE_PATH = 'workspace/lib/helpers-bridge.js';
export const HYBRID_RUNTIME_PATHS = Object.freeze(['answer', 'profile', 'resume', 'trash', 'activity']
  .map(name => `runtime/workspace-ui/lib/${name}-view.js`));
export const HYBRID_SERVING_MAP = Object.freeze({
  'workspace/lib/helpers.js': BRIDGE_PATH,
  'workspace/lib/helpers-original.js': 'workspace/lib/helpers.js',
  ...Object.fromEntries(HYBRID_RUNTIME_PATHS.map(path => [path, path])),
});
// These whole-file fingerprints bind static resolution to the reviewed Python
// serving implementation. A changed server needs explicit mapping review.
const SERVER_HASHES = Object.freeze({
  'scripts/job_apply_workspace/__init__.py': '4c0763d4d350961e76c819521cc7ac0f80cfdd5026ae9f161782b6664a7b21a4',
  'scripts/job_apply_workspace/queries.py': 'a34746be015c28e2ba8e69cf1931e7dd6db1c9ca0167f3ebaf8e5cfe722a1673',
});
export function validateServingMap(map) {
  if (map === undefined) return;
  if (!map || typeof map !== 'object' || Array.isArray(map)
    || Object.getPrototypeOf(map) !== Object.prototype
    || Reflect.ownKeys(map).length !== Object.keys(HYBRID_SERVING_MAP).length) {
    throw new Error('Unsupported browser serving map');
  }
  for (const [key, value] of Object.entries(HYBRID_SERVING_MAP)) {
    const property = Object.getOwnPropertyDescriptor(map, key);
    if (!property || !Object.hasOwn(property, 'value') || property.value !== value) {
      throw new Error('Unsupported browser serving map');
    }
  }
}
export function detectServingMap(files) {
  if (!files.has(BRIDGE_PATH)) return undefined;
  for (const [path, expected] of Object.entries(SERVER_HASHES)) {
    const source = files.get(path);
    if (typeof source !== 'string'
      || createHash('sha256').update(source).digest('hex') !== expected) {
      throw new Error(`Browser serving implementation requires review: ${path}`);
    }
  }
  return HYBRID_SERVING_MAP;
}
