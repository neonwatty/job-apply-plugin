import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverTestIds } from '../tools/migration/test-bindings.mjs';

test('literal test bindings require node:test imports and nonempty direct declarations', () => {
  const source = `import check from 'node:test';
    check('real', () => { throw new Error('never execute'); });
    check('empty', () => {});
    check.skip('skipped', () => { throw 1; });
    check('options', {skip:true}, () => { throw 1; });
    check(dynamicName, () => { throw 1; });
    other('unbound', () => { throw 1; });`;
  assert.deepEqual([...discoverTestIds('synthetic.mjs', source)], ['real']);
  assert.deepEqual([...discoverTestIds('synthetic.mjs', "import {test as check} from 'node:test'; check('named', () => 1);")], ['named']);
});
test('malformed syntax and duplicate declared test IDs cannot bind requirements', () => {
  assert.throws(() => discoverTestIds('x.mjs', 'import {'));
  assert.throws(() => discoverTestIds('x.mjs', "import test from 'node:test'; test('same', () => 1); test('same', () => 2);"), /Duplicate/);
});
