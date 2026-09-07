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

const header = "import test from 'node:test';\n";
const branch = "if(process.platform === 'win32'){test('windows',()=>1);}else{test('portable',()=>1);}";
const names = (source, platform = 'darwin') => [...discoverTestIds('synthetic.mjs', source, { platform })];

test('platform literal bindings select only the explicitly supplied finite branch in source order', () => {
  for (const [platform, equal, unequal] of [['win32', 'windows', 'portable'], ['darwin', 'portable', 'windows'], ['linux', 'portable', 'windows']]) {
    const source = header + "test('before',()=>1);" + branch + "test('after',()=>1);";
    assert.deepEqual(names(source, platform), ['before', equal, 'after']);
    assert.deepEqual(names(source.replace('===', '!=='), platform), ['before', unequal, 'after']);
  }
  assert.deepEqual(names(header + branch.replaceAll('portable', 'windows')), ['windows']);
  assert.throws(() => names(header + branch + "test('portable',()=>1);"), /Duplicate/);
  assert.deepEqual(names(header.replace('import test', 'import {test as check}') + branch.replaceAll('test(', 'check(')), ['portable']);
});

test('platform literal bindings preserve no-context behavior and reject unsupported syntax', () => {
  assert.deepEqual([...discoverTestIds('x.mjs', header + branch + "test('top',()=>1);")], ['top']);
  for (const context of [null, {}, { platform: 'plan9' }, { platform: 'darwin', extra: 1 }, { platform: 3 }, [], Object.assign([], {platform:'darwin'})]) {
    assert.throws(() => discoverTestIds('x.mjs', header + branch, context), /platform context/);
  }
  for (const source of [branch.replace('===', '=='), branch.replace('process.platform', "process['platform']"),
    branch.replace("'win32'", 'target'), branch.replace('process.platform', 'other.platform'),
    branch.replace('process.platform', 'process?.platform'), branch.replace("test('windows',()=>1);", "test('windows',{skip:true},()=>1);"),
    branch.replace("test('windows',()=>1);", "test('windows',()=>{});"), branch.replace("test('windows',()=>1);", "test(dynamic,()=>1);"),
    branch.replace("test('windows',()=>1);", "test.skip('windows',()=>1);"), branch.replace("test('windows',()=>1);", "const x=1;test('windows',()=>1);"),
    branch.replace("test('windows',()=>1);", "if(true){test('windows',()=>1);}"),
    "for(const x of [1]){" + branch + '}', branch.slice(0, branch.indexOf('else')),
    branch.replace("test('windows',()=>1);", "for(;;){test('windows',()=>1);}")]) {
    assert.deepEqual(names(header + source), [], source);
  }
  assert.throws(() => names(header + branch + '}'), /Invalid test source/);
  assert.deepEqual(names(branch), []);
});

test('platform literal bindings reject shadowed process and node test identities', () => {
  for (const shadow of ["const process={platform:'win32'};", "let {process}=globalThis;", 'function process(){}',
    'class process{}', "{var process={platform:'win32'};}", "if(false){var {process}=globalThis;}", "import process from 'node:process';", "import {anything as process} from 'elsewhere';",
    "const test=()=>{};"]) assert.deepEqual(names(header + shadow + branch), [], shadow);
  assert.deepEqual(names(header + branch.replace("test('windows',()=>1);", "const test=()=>{};test('windows',()=>1);")), []);
  const local = header + "test('local',()=>{const process={};return process;});" + branch;
  // Local-only bindings never add names from arbitrary nested scopes.
  assert.ok(names(local).includes('local'));
});

test('platform literal bindings reject process mutation and escaped process aliases', () => {
  for (const mutation of ["process.platform='win32';", "process['platform']='win32';", 'process.platform++;',
    'delete process.platform;', "({x:process.platform}={x:'win32'});", "for(process.platform of ['win32']){}", "Object.defineProperty(process,'platform',{value:'win32'});",
    "Object.defineProperties(process,{platform:{value:'win32'}});", "Reflect.set(process,'platform','win32');",
    "Reflect.defineProperty(process,'platform',{value:'win32'});", "Reflect.deleteProperty(process,'platform');",
    "Object.assign(process,{platform:'win32'});", "globalThis.process.platform='win32';", "global.process['platform']='win32';",
    "Object.defineProperty(globalThis,'process',{value:{platform:'win32'}});",
    "Object.defineProperties(global,{process:{value:{platform:'win32'}}});",
    "Object.assign(globalThis,{process:{platform:'win32'}});", "Reflect.set(globalThis,'process',{platform:'win32'});",
    "Reflect.defineProperty(global,'process',{value:{platform:'win32'}});", "Reflect.deleteProperty(globalThis,'process');",
    'const target=globalThis;', 'unknown(global);', 'const alias=process;', 'const {platform}=process;', 'unknown(process);', 'const alias=globalThis.process;']) {
    assert.deepEqual(names(header + mutation + branch), [], mutation);
  }
  const unchanged = header + 'const alias={};' + branch;
  assert.deepEqual(names(unchanged), ['portable']);
  assert.deepEqual(names(unchanged.replace('alias={}', 'alias=process')), []);
  assert.deepEqual(names(header + "const executable=process.platform==='win32'?'python':'python3';" + branch), ['portable']);
});

test('platform literal bindings match the three frozen S08 platform declarations', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const [file, expected] of [
    ['typed_json_oracle.test.mjs', platform => [
      `typed JSON independently matches ${platform} reference`, `${platform} typed reference rejects caller arguments and stdin`,
      ...['python3.12', 'python3.13', 'python3.14'].flatMap(p => [`typed JSON independently matches ${p} reference`, `${p} typed reference rejects caller arguments and stdin`])]],
    ['raw_json_numeric.test.mjs', platform => [
      'single numeric token grammar rejects whitespace, junk and alternate spellings',
      'integer identity, digit limits and signed zero are exact',
      'fixed finite scope formatting remains required without versioned executables', 'integer digit configuration rejects invalid limits',
      ...[platform, 'python3.12', 'python3.13', 'python3.14'].flatMap(p => [`independent numeric oracle from ${p}`, `${p} reference rejects caller arguments and stdin`])]],
    ['store_validation_ts.test.mjs', platform => [
      ...[platform, 'python3.12', 'python3.13', 'python3.14'].map(p => `document validation matches authoritative Python: ${p}`),
      'document validation preserves all entries and typed atom identities', 'fixed reference refuses caller arguments and input']],
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const [platform, executable] of [['win32', 'python'], ['darwin', 'python3'], ['linux', 'python3']]) {
      assert.deepEqual(names(source, platform), expected(executable), `${file}:${platform}`);
    }
  }
});

test('current inventory discovery uses explicit current platform without changing no-context consumers', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const { checkInventory, SCENARIOS } = await import('../tools/migration/check.mjs');
  const root = await mkdtemp(join(tmpdir(), 'platform-inventory-'));
  const data = new Map();
  const write = async (path, value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value) + '\n';
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text);
    data.set(path, createHash('sha256').update(text).digest('hex'));
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    await write('scripts/router.py', '# inert\n'); await write('tests_js/fixture.test.mjs', header + branch);
    await write('config/test-matrix.json', { schemaVersion: 1, suites: [{ id: 'fixture', kind: 'node-test', include: ['tests_js/fixture.test.mjs'] }] });
    await write('config/migration/nodes.json', { schemaVersion: 1, nodes: [{ id: 'CI', dependencies: [], status: 'open' }] });
    await write('config/migration/source-catalog-fixture.json', { schemaVersion: 1, sources: [{ path: 'scripts/router.py', sha256: data.get('scripts/router.py'), classification: 'unreviewed' }] });
    await write('config/migration/http-surfaces.json', { schemaVersion: 1, surfaces: [{ id: 'fixture', kind: 'http', method: 'GET', path: '/fixture', node: 'CI', sources: ['scripts/router.py'], effects: 'unclassified', scenarios: Object.fromEntries(SCENARIOS.map(x => [x, 'unverified'])) }] });
    const requirement = { id: 'fixture.valid', family: 'CI', surfaceIds: ['fixture'], category: 'valid', applicability: { status: 'required' }, platformCells: ['node-local'], oracleFiles: [{ path: 'scripts/router.py', sha256: data.get('scripts/router.py') }], expectedArtifacts: ['fixture.json'], testBindings: [{ suiteId: 'fixture', file: 'tests_js/fixture.test.mjs', testId: process.platform === 'win32' ? 'windows' : 'portable', command: ['node', '--test', 'tests_js/fixture.test.mjs'], timeoutMs: 1000, maxOutputBytes: 1000 }] };
    for (const wrong of [false, true]) {
      if (wrong) requirement.testBindings[0].testId = process.platform === 'win32' ? 'portable' : 'windows';
      await write('config/migration/requirements-fixture.json', { schemaVersion: 1, requirements: [requirement] });
      await write('config/migration/review-lock.json', { schemaVersion: 1, files: [...data].filter(([p]) => p.startsWith('config/migration/') && !p.endsWith('/review-lock.json')).map(([p, sha256]) => ({ path: p.split('/').at(-1), sha256 })) });
      const result = await checkInventory(root);
      assert.deepEqual(result.errors, wrong ? ['fixture.valid: undeclared test identity'] : []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
