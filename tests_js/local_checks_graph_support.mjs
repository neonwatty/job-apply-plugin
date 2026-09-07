import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_PATH, digest, NATIVE_ROOTS } from '../tools/local-checks/focused-contracts.mjs';

const HERE = fileURLToPath(new URL('../', import.meta.url));
export const GRAPH_SOURCE = 'src/contracts/raw-json/float-scope.ts';
export const GRAPH_RUNTIME = 'runtime/contracts/raw-json/float-scope.js';
export const GRAPH_TEST = 'tests_js/direct.test.mjs';
export const GRAPH_CHILD = 'tests_js/child.test.mjs';
export const GRAPH_SUPPORT = 'tests_js/consumer-support.mjs';

// A disposable complete six-rule schema; expected dependencies are authored, not scanner output.
export async function createGraphFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'local-consumer-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new Map([
    ['package.json', '{"type":"module","devDependencies":{"typescript":"5.9.3"}}\n'],
    ['package-lock.json', '{"lockfileVersion":3}\n'], ['tsconfig.json', '{}\n'],
    ['README.md', 'Owned fixture documentation.\n'],
    [GRAPH_SOURCE, 'export const value = 1;\n'], [GRAPH_RUNTIME, 'export const value = 1;\n'],
    [GRAPH_SUPPORT, `export { value } from '../${GRAPH_RUNTIME}';\n`],
    [GRAPH_TEST, `import test from 'node:test';\nimport { value } from './consumer-support.mjs';\ntest('direct behavior', () => { if (value !== 1) throw Error('mutant'); });\n`],
    [GRAPH_CHILD, `import test from 'node:test';\nimport { spawnSync } from 'node:child_process';\ntest('child behavior', () => { const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; const result = spawnSync(process.execPath, ['--test', 'tests_js/direct.test.mjs'], { env }); if (result.status !== 0) throw Error('child failed'); });\n`],
  ]);
  for (const path of NATIVE_ROOTS) files.set(path, "import test from 'node:test';\ntest('owned native substitute', () => {});\n");
  for (const name of ['consumer-graph.mjs', 'graph-syntax.mjs', 'focused-contracts.mjs', 'focused-closure.mjs']) {
    files.set(`tools/local-checks/${name}`, await readFile(join(HERE, `tools/local-checks/${name}`), 'utf8'));
  }
  for (const name of ['matrix.mjs', 'patterns.mjs']) {
    files.set(`tools/test-runner/${name}`, await readFile(join(HERE, `tools/test-runner/${name}`), 'utf8'));
  }
  for (const [path, content] of Object.entries(overrides)) files.set(path, content);
  const ids = ['local-numeric', 'local-typed-json', 'local-store-validation', 'local-resume-view', 'local-raw-reference', 'local-profile-reference'];
  const rules = ids.map((id, index) => ({ id, runtimePaths: index === 0 ? [GRAPH_SOURCE, GRAPH_RUNTIME] : [],
    sharedContractPaths: [], referencePaths: [], referenceTests: [], testInputPaths: [], testInputCompanions: [],
    lightTests: index === 0 ? [GRAPH_TEST, GRAPH_CHILD] : [], heavyTests: [] }));
  const candidates = [...files].filter(([path]) => /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(path))
    .map(([path, content]) => ({ path, sha256: digest(content) })).sort((a, b) => a.path.localeCompare(b.path));
  const contract = { schemaVersion: 1, rules, nativeFallback: { testRoots: NATIVE_ROOTS, reuseAllowed: false },
    inventory: { candidates, candidateCount: candidates.length, candidateDigest: digest(JSON.stringify(candidates)), edges: [], calls: [], urls: [] } };
  files.set(CONTRACT_PATH, JSON.stringify(contract));
  async function write(path, content) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content);
    files.set(path, content);
  }
  for (const [path, content] of files) await write(path, content);
  return { root, files, contract, write, tracked: () => [...files.keys()].sort(),
    writeContract: () => write(CONTRACT_PATH, JSON.stringify(contract)) };
}
