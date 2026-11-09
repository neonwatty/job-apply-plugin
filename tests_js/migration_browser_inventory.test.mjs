import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverBrowserExports, checkBrowserBindings } from '../tools/migration/browser-exports.mjs';

test('static export discovery never executes browser bootstrap and preserves barrel origins', () => {
  const files = new Map([
    ['workspace/app.js', 'throw new Error("must not run"); export * from "./lib.js";'],
    ['workspace/lib.js', 'export function helper() {} export const value = 1; export default 2;'],
  ]);
  const actual = discoverBrowserExports(files);
  assert.deepEqual(actual.filter((item) => item.path === 'workspace/app.js'), [
    { path: 'workspace/app.js', name: 'helper', sources: ['workspace/app.js', 'workspace/lib.js'] },
    { path: 'workspace/app.js', name: 'value', sources: ['workspace/app.js', 'workspace/lib.js'] },
  ]);
  assert.ok(actual.some((item) => item.path === 'workspace/lib.js' && item.name === 'default'));
});
test('renamed and namespace exports stay public without importing their module', () => {
  const actual = discoverBrowserExports(new Map([
    ['workspace/a.js', 'export { value as renamed } from "./b.js"; export * as helpers from "./b.js";'],
    ['workspace/b.js', 'export const value = 1;'],
  ]));
  assert.deepEqual(actual.filter((item) => item.path === 'workspace/a.js').map((item) => item.name), ['renamed', 'helpers']);
});
test('missing modules, invalid syntax, escaping and ambiguous reexports fail closed', () => {
  for (const text of ['export * from "./missing.js";', 'export * from "../outside.js";',
    'export * from "package";', 'export const { x } = value;', 'export function broken(']) {
    assert.throws(() => discoverBrowserExports(new Map([['workspace/a.js', text]])));
  }
  assert.throws(() => discoverBrowserExports(new Map([
    ['workspace/a.js', 'export * from "./b.js"; export * from "./c.js";'],
    ['workspace/b.js', 'export const x=1;'], ['workspace/c.js', 'export const x=2;'],
  ])), /Ambiguous/);
});
test('added, deleted, renamed or source-unbound exports require ledger reconciliation', () => {
  const discovered = [{ path: 'workspace/a.js', name: 'helper', sources: ['workspace/a.js', 'workspace/b.js'] }];
  const surface = { kind: 'browser', export: 'helper', sources: ['workspace/a.js', 'workspace/b.js'] };
  assert.deepEqual(checkBrowserBindings(discovered, [surface]), []);
  assert.match(checkBrowserBindings(discovered, []).join('\n'), /Uninventoried/);
  assert.match(checkBrowserBindings([], [surface]).join('\n'), /Obsolete/);
  assert.match(checkBrowserBindings(discovered, [{ ...surface, sources: ['workspace/a.js'] }]).join('\n'), /Missing browser binding/);
  assert.ok(checkBrowserBindings(discovered, [{ ...surface, export: 'renamed' }]).length);
});
test('local export lists and multiple star binding chains require explicit review', () => {
  for (const source of ['export { missing };', 'import { x } from "./b.js"; export { x };']) {
    assert.throws(() => discoverBrowserExports(new Map([
      ['workspace/a.js', source], ['workspace/b.js', 'export const x = 1;'],
    ])), /binding review/);
  }
  assert.throws(() => discoverBrowserExports(new Map([
    ['workspace/a.js', 'export * from "./b.js"; export * from "./c.js";'],
    ['workspace/b.js', 'export { x as same } from "./d.js";'],
    ['workspace/c.js', 'export { y as same } from "./d.js";'],
    ['workspace/d.js', 'export const x = 1, y = 2;'],
  ])), /Ambiguous/);
});

import { HYBRID_SERVING_MAP, HYBRID_RUNTIME_PATHS, detectServingMap } from '../tools/migration/browser-serving-map.mjs';
const hybridFiles = () => new Map([
  ['workspace/app.js', 'export * from "./lib/helpers.js";'],
  ['workspace/lib/helpers.js', 'export function original() {} export function fileToBase64() {}'],
  ['workspace/lib/helpers-bridge.js', 'export { compiled } from "../../runtime/workspace-ui/lib/answer-view.js"; export { fileToBase64 } from "./helpers-original.js";'],
  ...HYBRID_RUNTIME_PATHS.map(path => [path, 'export function compiled() {}']),
]);
test('closed browser serving map preserves physical originals and actual app runtime origins', () => {
  const found = discoverBrowserExports(hybridFiles(), HYBRID_SERVING_MAP);
  assert.deepEqual(found.find(row => row.path === 'workspace/app.js' && row.name === 'compiled').sources,
    ['workspace/app.js', 'workspace/lib/helpers-bridge.js', 'runtime/workspace-ui/lib/answer-view.js']);
  assert.deepEqual(found.find(row => row.path === 'workspace/app.js' && row.name === 'fileToBase64').sources,
    ['workspace/app.js', 'workspace/lib/helpers-bridge.js', 'workspace/lib/helpers.js']);
  assert.ok(found.some(row => row.path === 'workspace/lib/helpers.js' && row.name === 'original'));
  assert.equal(found.filter(row => row.path.startsWith('runtime/')).length, 5);
  assert.deepEqual(checkBrowserBindings(found, found.map(row => ({kind:'browser',export:row.name,sources:row.sources}))), []);
  assert.throws(() => discoverBrowserExports(hybridFiles()), /escapes workspace/);
});
test('closed browser serving map rejects arbitrary aliases accessors missing leaves and escapes', () => {
  for (const map of [null, {}, {...HYBRID_SERVING_MAP, extra:'workspace/x.js'},
    {...HYBRID_SERVING_MAP, 'workspace/lib/helpers.js':'workspace/lib/helpers.js'},
    Object.create(HYBRID_SERVING_MAP), Object.defineProperty({...HYBRID_SERVING_MAP}, 'workspace/lib/helpers.js', {get(){throw Error('never execute');}})]) {
    assert.throws(() => discoverBrowserExports(hybridFiles(), map), /Unsupported browser serving map/);
  }
  const missing = hybridFiles();missing.delete(HYBRID_RUNTIME_PATHS[0]);
  assert.throws(() => discoverBrowserExports(missing, HYBRID_SERVING_MAP), /Missing browser export source/);
  const escaping = hybridFiles();escaping.set('workspace/lib/helpers-bridge.js','export * from "../../runtime/private.js";');
  assert.throws(() => discoverBrowserExports(escaping, HYBRID_SERVING_MAP), /escapes workspace/);
  const cyclic = hybridFiles();cyclic.set('workspace/lib/helpers-bridge.js','export * from "./helpers.js";');
  assert.throws(() => discoverBrowserExports(cyclic, HYBRID_SERVING_MAP), /Cyclic/);
});
test('browser serving detection stays disabled without bridge and rejects unreviewed server bytes', () => {
  assert.equal(detectServingMap(new Map()), undefined);
  assert.throws(() => detectServingMap(hybridFiles()), /serving implementation requires review/);
  const bad = hybridFiles();bad.set('scripts/job_apply_workspace/__init__.py','ASSETS = {}');
  assert.throws(() => detectServingMap(bad), /serving implementation requires review/);
});
