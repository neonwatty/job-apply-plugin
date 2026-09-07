import { readFile, realpath, stat, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { delimiter, join, isAbsolute } from 'node:path';
import ts from 'typescript';
import { suiteFiles, validateMatrix } from '../test-runner/matrix.mjs';
import { analyzeSource, resolveEdge, inspectRunnerBindings, RUNNER_MODULES, RUNNER_IDENTITIES, EXECUTABLE_TARGET_HASHES, CALLER_PROCESS_RECIPES } from './graph-syntax.mjs';
import { CONTRACT_PATH, SOURCE_SUFFIX, NATIVE_ROOTS, PYTHON_SOURCE_PATH, PYTHON_INVENTORY_SHA256, SKILL_SOURCE_PATH, SKILL_INVENTORY_SHA256, PROCESS_RECIPES, EXTRA_CALLER_PROCESS_RECIPES, NPM_QUERY_SOURCE_SHA256, FINITE_EXPRESSIONS, digest, ordered, readRegular, loadFocusedContracts } from './focused-contracts.mjs';

export function reverseClosure(edges, seeds, { types = false, emissions = types, tracked = new Set() } = {}) {
  const reverse = new Map(), changedBytes = new Set(seeds);
  for (const edge of edges) {
    if (!types && edge.kind === 'type-import') continue;
    if (edge.kind === 'reviewed-finite-test-source-read' && !changedBytes.has(edge.to)) continue;
    if (!reverse.has(edge.to)) reverse.set(edge.to, []);
    reverse.get(edge.to).push(edge.from);
  }
  const found = new Set(), pending = [...seeds];
  while (pending.length) {
    const path = pending.pop();
    if (found.has(path)) continue;
    found.add(path); pending.push(...reverse.get(path) ?? []);
    if (emissions && path.startsWith('src/') && path.endsWith('.ts')) {
      const emitted = path.replace(/^src\//, 'runtime/').replace(/\.ts$/, '.js');
      if (tracked.has(emitted)) pending.push(emitted);
    }
  }
  return ordered(found);
}

export async function discoverConsumerGraph(root, tracked) {
  const reasons = [], edges = [], resolutionErrors = [], candidates = [], calls = [], hashes = new Map(), invalidPaths = new Set();
  let contract;
  try { contract = await loadFocusedContracts(root); }
  catch (error) { reasons.push(error.message); }
  const paths = new Set(tracked), parsed = new Map(), sources = new Map();
  let packages = new Set();
  const identity = [];
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    try {
      const bytes = await readRegular(root, path); identity.push([path, digest(bytes)]);
      if (path === 'package.json') { const value = JSON.parse(bytes); packages = new Set(Object.keys({ ...value.dependencies, ...value.devDependencies })); }
    } catch (error) { reasons.push(error.message); }
  }
  for (const name of ['consumer-graph.mjs', 'graph-syntax.mjs', 'focused-contracts.mjs', 'focused-closure.mjs']) {
    try {
      const actual = await readFile(new URL(name, import.meta.url));
      const snapshot = await readRegular(root, `tools/local-checks/${name}`);
      identity.push([name, digest(actual), digest(snapshot)]);
      if (!actual.equals(snapshot)) reasons.push(`Executing analyzer differs from snapshot: ${name}`);
    } catch (error) { reasons.push(error.message); }
  }
  identity.push(['typescript implementation', digest(await readFile(new URL(import.meta.resolve('typescript'))))]);
  let totalBytes = 0;
  for (const path of ordered(paths).filter(path => SOURCE_SUFFIX.test(path))) {
    try {
      const bytes = await readRegular(root, path);
      totalBytes += bytes.length;
      if (totalBytes > 64 * 1024 * 1024) throw new Error('Graph source budget exceeded');
      const sha256 = digest(bytes); hashes.set(path, sha256); sources.set(path, bytes.toString('utf8')); candidates.push({ path, sha256 });
      const result = analyzeSource(path, bytes.toString('utf8')); parsed.set(path, result);
      calls.push(...result.calls);
      for (const error of result.unresolved) reasons.push(`${error.path}: ${error.reason}`);
      for (const edge of result.edges) {
        const resolved = resolveEdge(edge, paths, packages);
        if (resolved.error) resolutionErrors.push({ from: path, edge, error: resolved.error });
        else if (resolved.path) edges.push({ from: path, to: resolved.path, kind: edge.kind });
      }
    } catch (error) { invalidPaths.add(path); reasons.push(error.message); }
  }
  const synthetic = validatedFixtureTargets(edges, hashes);
  for (const item of resolutionErrors) {
    if (item.edge.kind === 'literal-child-process' && synthetic.has(`${item.from}:${item.error}`)) continue;
    reasons.push(`${item.from}: ${item.error}`);
  }
  const dispatch = await projectDispatchers(root, paths, sources, hashes, edges);
  reasons.push(...dispatch.reasons); identity.push(['dispatcher routes', dispatch.fingerprint]);
  // Reviewed finite browser/fixture loops remain valid only with their complete source identity.
  const reviewed = contract?.value.inventory;
  for (const edge of reviewed?.edges ?? []) if (edge.kind.startsWith('reviewed-')) {
    if (hashes.get(edge.from) !== contract.candidates.get(edge.from)) {
      reasons.push(`Reviewed finite mapping changed: ${edge.from}`); continue;
    }
    if (!paths.has(edge.to)) reasons.push(`Missing reviewed target: ${edge.to}`);
    else edges.push(edge);
  }
  const checkedTargets = new Set();
  for (const path of ordered(paths).filter(path => (path.startsWith('docs/') || ['README.md', 'LICENSE'].includes(path)) && !hashes.has(path))) {
    try { hashes.set(path, digest(await readRegular(root, path))); }
    catch (error) { invalidPaths.add(path); reasons.push(error.message); }
  }
  for (const edge of edges) if (!hashes.has(edge.to) && !checkedTargets.has(edge.to)) {
    checkedTargets.add(edge.to);
    try { hashes.set(edge.to, digest(await readRegular(root, edge.to))); }
    catch (error) { invalidPaths.add(edge.to); reasons.push(error.message); }
  }
  const nativeCallers = new Set(reverseClosure(edges, [
    'src/store/posix-flock.ts', 'runtime/store/posix-flock.js',
    'src/package/posix-timestamps.ts', 'runtime/package/posix-timestamps.js',
    'tools/build-native-lock.mjs', 'tools/build-native-timestamps.mjs',
    'tools/contracts/heavy-run-lease/reference.mjs',
  ], { types: true, tracked: paths }));
  let pythonInventory;
  const callerRecipes = [...CALLER_PROCESS_RECIPES, ...EXTRA_CALLER_PROCESS_RECIPES].filter(recipe => (!recipe.python || !process.env.PYTHON)
    && recipe.callers.every(row => hashes.get(row.path) === row.sha256)
    && JSON.stringify(reverseClosure(edges, [recipe.path], { types: true }))
      === JSON.stringify(recipe.callers.map(row => row.path)));
  for (const call of calls.filter(call => call.resolution !== 'resolved')) {
    if (synthetic.has(`${call.path}:site:${call.sha256}`)) continue;
    const known = [...reviewed?.calls ?? [], ...reviewed?.urls ?? []].some(row => row.path === call.path && row.sha256 === call.sha256);
    const unchanged = hashes.get(call.path) === contract?.candidates.get(call.path);
    const finite = known && unchanged && FINITE_EXPRESSIONS.get(call.path)?.includes(call.expression)
      && (reviewed?.edges ?? []).some(edge => edge.from === call.path && edge.kind.startsWith('reviewed-'));
    if (finite && ['import', 'URL'].includes(call.kind)) continue;
    const nativeProvider = /^(?:src|runtime)\/(?:store\/posix-flock|package\/posix-timestamps)\./.test(call.path)
      && ['require', 'chained-createRequire'].includes(call.kind);
    const nativeBuilder = ['tools/build-native-lock.mjs', 'tools/build-native-timestamps.mjs'].includes(call.path)
      && call.expression.startsWith('spawnSync(compiler,');
    if (known && unchanged && nativeCallers.has(call.path) && (nativeProvider || nativeBuilder)) continue;
    const nativeRecipe = NATIVE_PROVIDER_RECIPES.find(row => row.path === call.path
      && row.sourceSha256 === hashes.get(call.path) && row.callHashes.includes(call.sha256));
    if (nativeRecipe && hashes.get(nativeRecipe.builder) === nativeRecipe.builderSha256
      && nativeRecipe.callers.every(row => hashes.get(row.path) === row.sha256)
      && JSON.stringify(reverseClosure(edges, [call.path], { types: true }))
        === JSON.stringify(nativeRecipe.callers.map(row => row.path))) continue;

    if (dispatch.sites.has(`${call.path}:${call.sha256}`)) continue;
    if (call.path === 'tools/local-checks/consumer-graph.mjs' && hashes.get(call.path) === NPM_QUERY_SOURCE_SHA256
      && call.expression === NPM_QUERY_EXPRESSION) continue;
    const available = [...PROCESS_RECIPES, ...LOCAL_PROCESS_RECIPES, ...callerRecipes,
      ...(!process.env.PYTHON && dispatch.proved ? PROFILE_RECIPES : [])];
    const recipe = available.find(item => item.path === call.path && item.callHashes.includes(call.sha256)
      && item.sourceSha256 === hashes.get(call.path));
    if (recipe) {
      if (recipe.skillDocuments) {
        if (await observedPythonInventory(root, paths, hashes, SKILL_SOURCE_PATH) !== SKILL_INVENTORY_SHA256) {
          reasons.push('Unreviewed skill document inventory');
        }
        for (const target of [...paths].filter(SKILL_SOURCE_PATH)) edges.push({ from: call.path, to: target, kind: 'reviewed-skill-document' });
      }
      for (const binding of recipe.requiredSourceBindings ?? []) {
        if (paths.has(binding.path) && !hashes.has(binding.path)) {
          try { hashes.set(binding.path, digest(await readRegular(root, binding.path))); }
          catch (error) { reasons.push(error.message); }
        }
        if (!paths.has(binding.path) || hashes.get(binding.path) !== binding.sha256) {
          reasons.push(`Unreviewed process source helper: ${binding.path}`);
        }
      }
      if (recipe.python || PROFILE_RECIPES.includes(recipe)) {
        pythonInventory ??= await observedPythonInventory(root, paths, hashes);
        if (pythonInventory !== PYTHON_INVENTORY_SHA256) reasons.push('Unreviewed Python source inventory');
      }
      for (const target of recipe.repositoryTargets.filter(PYTHON_SOURCE_PATH)) {
        if (!hashes.has(target)) {
          try { hashes.set(target, digest(await readRegular(root, target))); }
          catch (error) { reasons.push(error.message); }
        }
        if (!EXECUTABLE_TARGET_HASHES[target] || hashes.get(target) !== EXECUTABLE_TARGET_HASHES[target]) {
          reasons.push(`Unreviewed executable driver: ${target}`);
        }
      }
      for (const target of recipe.repositoryTargets) {
        if (!paths.has(target)) reasons.push(`Missing process recipe target: ${target}`);
        else edges.push({ from: call.path, to: target, kind: 'reviewed-process-target' });
      }
      continue;
    }
    reasons.push(`Unresolved ${call.kind} caller: ${call.path}:${call.start}`);
  }
  for (const edge of edges) if (!hashes.has(edge.to) && !checkedTargets.has(edge.to)) {
    checkedTargets.add(edge.to);
    try { hashes.set(edge.to, digest(await readRegular(root, edge.to))); }
    catch (error) { invalidPaths.add(edge.to); reasons.push(error.message); }
  }
  for (const path of NATIVE_ROOTS) if (!paths.has(path) || invalidPaths.has(path)) reasons.push(`Missing native test root: ${path}`);
  const nativeTests = ordered([...NATIVE_ROOTS, ...nativeCallers].filter(path => /\.test\.mjs$/.test(path)));
  const uniqueEdges = [...new Map(edges.map(edge => [JSON.stringify(edge), edge])).values()];
  const fingerprint = digest(JSON.stringify({ candidates, targets: [...hashes].sort(([a], [b]) => a.localeCompare(b)), edges: uniqueEdges, identity, contract: contract?.fingerprint,
    compiler: ts.version, nativeTests, reasons: ordered(reasons) }));
  return { root, tracked: paths, hashes, candidates, edges: uniqueEdges, contract: contract?.value,
    invalidPaths, reasons: ordered(reasons), nativeTests, dispatchRoutes: dispatch.routes, fingerprint };
}

// Dispatch is invocation-aware: its selected roots are not ordinary imports of every runner consumer.
export async function projectDispatchers(root, paths, sources, hashes, edges) {
  const reasons = [], routes = [], sites = new Set();
  if (![...RUNNER_MODULES.keys()].some(path => sources.has(path))) {
    return { reasons, routes, sites, fingerprint: digest('no runner dispatchers') };
  }
  const expected = new Map(RUNNER_IDENTITIES.map(row => [row.path, row]));
  for (const [path, source] of sources) {
    const observed = inspectRunnerBindings(path, source, RUNNER_MODULES);
    reasons.push(...observed.issues);
    if (!observed.bindings.length && !expected.has(path)) continue;
    const known = expected.get(path);
    if (!known || known.sourceHash !== hashes.get(path) || known.bindingHash !== digest(JSON.stringify(observed))) {
      reasons.push(`Unproved runner caller or implementation: ${path}`);
    }
  }
  for (const path of expected.keys()) if (!sources.has(path)) reasons.push(`Missing runner proof source: ${path}`);
  for (const edge of edges) if (RUNNER_MODULES.has(edge.to) && edge.kind === 'literal-loader') {
    reasons.push(`Dynamic runner namespace escapes: ${edge.from}`);
  }
  const context = Object.fromEntries(['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'npm_config_script_shell', 'NPM_CONFIG_SCRIPT_SHELL', 'npm_config_prefix', 'NPM_CONFIG_PREFIX', 'npm_config_location', 'NPM_CONFIG_LOCATION'].map(name => [name, process.env[name] ?? null]));
  if (Object.values(context).some(Boolean)) reasons.push('Unproved runner environment override');
  let npmContext;
  try { npmContext = await effectiveNpmContext(root); }
  catch (error) { reasons.push(`Npm execution context: ${error.message}`); }
  let matrix, pkg;
  try {
    matrix = JSON.parse(await readRegular(root, 'config/test-matrix.json'));
    pkg = JSON.parse(await readRegular(root, 'package.json'));
    reasons.push(...validateMatrix(matrix, [...paths]).map(reason => `Dispatcher matrix: ${reason}`));
    for (const suite of matrix.suites) {
      if (Object.keys(suite.env ?? {}).length) { reasons.push(`Unproved suite environment: ${suite.id}`); continue; }
      if (suite.kind === 'node-test' || suite.kind === 'python-unittest') {
        routes.push({ id: suite.id, kind: suite.kind, targets: suiteFiles(suite, [...paths]), platforms: suite.platforms ?? null });
      } else {
        const command = resolveDispatchCommand(suite.command, pkg.scripts ?? {});
        if (command.error) reasons.push(`${suite.id}: ${command.error}`);
        else if (command.kind === 'release-shell' && (suite.tiers ?? []).some(tier => tier !== 'release')) {
          reasons.push(`Release shell in focused tier: ${suite.id}`);
        } else routes.push({ id: suite.id, ...command, platforms: suite.platforms ?? null });
      }
    }
    // The only command override in runTarget appends an immutable Git base to the size check.
    if (pkg.scripts?.['check:size'] !== 'python3 scripts/check-source-size.py') reasons.push('Unproved source-size command override');
    for (const route of routes) for (const target of route.targets) {
      if (!paths.has(target)) { reasons.push(`Missing dispatcher target: ${target}`); continue; }
      try { hashes.set(target, digest(await readRegular(root, target))); }
      catch (error) { reasons.push(error.message); }
    }
  } catch (error) { reasons.push(`Dispatcher contract: ${error.message}`); }
  if (!reasons.length) {
    // Every generic site is enabled only after its complete caller and current command projection passed.
    for (const row of GENERIC_DISPATCH_SITES) sites.add(`${row.path}:${row.sha256}`);
  }
  return { reasons, routes, sites, proved: reasons.length === 0, fingerprint: digest(JSON.stringify({
    expected: RUNNER_IDENTITIES, matrix, scripts: pkg?.scripts, context, python: process.env.PYTHON ?? null, npmContext, routes,
    targets: routes.flatMap(route => route.targets.map(path => [path, hashes.get(path)])), reasons,
  })) };
}

export function resolveDispatchCommand(argv, scripts, seen = new Set()) {
  const invalid = { error: 'Unproved dispatcher command' };
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) return invalid;
  const [executable, ...args] = argv;
  if (executable === 'node' && args.length && !args[0].startsWith('-') && /\.[cm]?js$/.test(args[0])) {
    return { kind: 'node-file', targets: [args[0]], argv };
  }
  if (executable === 'npm' && args[0] === 'run' && args.length === 2 && !seen.has(args[1])) {
    if (scripts[`pre${args[1]}`] || scripts[`post${args[1]}`]) return { error: 'Unproved npm lifecycle script' };
    const script = scripts[args[1]];
    if (typeof script !== 'string' || !/^[\w./: -]+$/.test(script)) return invalid;
    const next = new Set(seen); next.add(args[1]);
    const route = resolveDispatchCommand(script.split(/\s+/), scripts, next);
    return route.error ? route : { ...route, npmScript: args[1], script };
  }
  if (executable === 'tsc' && JSON.stringify(args) === JSON.stringify(['--noEmit', '--project', 'tsconfig.json'])) {
    return { kind: 'typescript-check', targets: ['tsconfig.json'], argv };
  }
  if (['python', 'python3'].includes(executable)) {
    if (args[0] === '-m' && args[1] === 'unittest' && args[2] === '-v'
      && args.length > 3 && args.slice(3).every(value => /^tests\.[A-Za-z_][\w]*$/.test(value))) {
      return { kind: 'python-unittest', targets: args.slice(3).map(value => value.replaceAll('.', '/') + '.py'), argv };
    }
    if (args.length === 1 && args[0] === 'scripts/check-source-size.py') return { kind: 'python-file', targets: args, argv };
  }
  // Release-only shell entrypoints stay explicit deferred routes, never portable focused acceptance.
  if (executable === 'bash' && args.length === 1 && ['scripts/check-links.sh', 'scripts/smoke-plugin.sh'].includes(args[0])) {
    return { kind: 'release-shell', targets: args, argv };
  }
  return invalid;
}

const GENERIC_DISPATCH_SITES = [
  {
    "path": "tools/local-checks/git.mjs",
    "sha256": "42fd319e0d3044d485d86e4c8e0321f801976033fa8ec64bfe6e5b14f420bc16"
  },
  {
    "path": "tools/local-checks/process.mjs",
    "sha256": "18a968429730f89d1f4dafc1e574d99d032fe60283b34ee7c0f83d847f0c42dc"
  },
  {
    "path": "tools/test-runner/process.mjs",
    "sha256": "a0f979859f50c2ee30ca619da3d7fce024eea1e61c898b97b49e67e1992a76d3"
  },
  {
    "path": "tools/test-runner/process.mjs",
    "sha256": "c61346f9e9ec6eb691c3cc6e2fe0e4a31e0844be800fa9bcd90158eb64956d6e"
  }
];

const NPM_QUERY_EXPRESSION = "execFileSync(npmPath, ['config', 'get', 'script-shell', 'node-options', 'workspace', 'workspaces', 'include-workspace-root', 'global', '--json'], {\n    cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],\n  })";
async function effectiveNpmContext(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm.exe'] : ['npm'];
  let npmPath;
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) throw new Error('Relative or empty PATH component');
    for (const name of names) {
      const candidate = join(directory, name);
      try { if ((await stat(candidate)).isFile()) { await access(candidate, constants.X_OK); npmPath = candidate; break; } }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'EACCES') throw error; }
    }
    if (npmPath) break;
  }
  if (!npmPath) throw new Error('npm executable unavailable');
  const executable = await realpath(npmPath), before = digest(await readFile(executable));
  const output = execFileSync(npmPath, ['config', 'get', 'script-shell', 'node-options', 'workspace', 'workspaces', 'include-workspace-root', 'global', '--json'], {
    cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (output.trim() !== 'script-shell=null\nnode-options=null\nworkspace=\nworkspaces=null\ninclude-workspace-root=false\nglobal=false') throw new Error('Nondefault npm execution settings');
  if (before !== digest(await readFile(executable))) throw new Error('npm changed during discovery');
  return { executable, sha256: before, settings: output.trim() };
}

// These fixtures generate their named tests in disposable repositories. No real source edge is erased.
function validatedFixtureTargets(edges, hashes) {
  const result = new Set();
  for (const boundary of FIXTURE_BOUNDARIES) {
    const observed = reverseClosure(edges, [boundary.helper], { types: true });
    if (JSON.stringify(observed) !== JSON.stringify(boundary.callers.map(row => row.path).sort())) continue;
    if (boundary.callers.some(row => hashes.get(row.path) !== row.sha256)) continue;
    if (boundary.target) result.add(`${boundary.helper}:missing target ${boundary.target}`);
    for (const callHash of boundary.callHashes) result.add(`${boundary.helper}:site:${callHash}`);
  }
  return result;
}

const FIXTURE_BOUNDARIES = [
  {
    helper: "tests_js/migration_task_support.mjs",
    target: "tests_js/audit.test.mjs",
    callHashes: ["7f338436c9cbac6bdc43b688f03e07e7a4ecb5742926e08339f442a44dbc3cb0"],
    callers: [
      {"path":"tests_js/migration_task_handoff_support.mjs","sha256":"18e4246982906de4c60d078345d32042d7dfc29145347c281df8bb853facdb74"},
      {"path":"tests_js/migration_task_handoffs.test.mjs","sha256":"5c428281eaf4807ab6d276d15320fd367ce50be27e091f8cb35384c1867a0865"},
      {"path":"tests_js/migration_task_lineage_git_support.mjs","sha256":"d14bb06fd26f705d8ef1309efd92deecb8292fd719dd9f72079f80a3d1d3bf79"},
      {"path":"tests_js/migration_task_lineage_lifecycle.test.mjs","sha256":"550b46a665d01d21dacad0904000452ffe9985d0d071b8d5f420ed50eba7a8f0"},
      {"path":"tests_js/migration_task_loader.test.mjs","sha256":"657ea134978c37e1f27bf965585c312331631dc6aa5148709c17571957ef70fc"},
      {"path":"tests_js/migration_task_manifests.test.mjs","sha256":"616a108615a2de3f48a2d9272f10907ab968183593fca0ead2555518a85da087"},
      {"path":"tests_js/migration_task_metadata.test.mjs","sha256":"7f504ef6da451bb2402a892ec7c2c65cc09b821b113da7366866312cd02babf0"},
      {"path":"tests_js/migration_task_receipts.test.mjs","sha256":"ba2bb192853a99af4909dbfe1963d1aebd96b3a9f9241cd7090bfbfd7ac9f16d"},
      {"path":"tests_js/migration_task_replacements.test.mjs","sha256":"f265c3385c2fe3ac036689ec70147ed67cdb2d92933baad1045aa945179110ba"},
      {"path":"tests_js/migration_task_support.mjs","sha256":"ddbf80c4d7559f7fd34ab4c9e72fd5b865555deffc8816ae58f20b7d5fef65a2"},
    ],
  },
  {
    helper: "tests_js/migration_task_handoff_support.mjs",
    target: "tests_js/product.test.mjs",
    callHashes: ["8a9ba29dc476889a4ab3998a04aeaf7c5846a7c0aa695e37526fe8d4f2ce1bb4"],
    callers: [
      {"path":"tests_js/migration_task_handoff_support.mjs","sha256":"18e4246982906de4c60d078345d32042d7dfc29145347c281df8bb853facdb74"},
      {"path":"tests_js/migration_task_handoffs.test.mjs","sha256":"5c428281eaf4807ab6d276d15320fd367ce50be27e091f8cb35384c1867a0865"},
      {"path":"tests_js/migration_task_lineage_lifecycle.test.mjs","sha256":"550b46a665d01d21dacad0904000452ffe9985d0d071b8d5f420ed50eba7a8f0"},
      {"path":"tests_js/migration_task_metadata.test.mjs","sha256":"7f504ef6da451bb2402a892ec7c2c65cc09b821b113da7366866312cd02babf0"},
    ],
  },
  {
    helper: "tests_js/migration_task_lineage_git_support.mjs",
    callHashes: ["8a9ba29dc476889a4ab3998a04aeaf7c5846a7c0aa695e37526fe8d4f2ce1bb4","26c015e046325720b7d54265cb92d3679114a10e465c533b9954d36a4e09062d","fa5ba5fd2046adff9c1d8f21fb3b2042bfc09047e6b2496e2a9904c85d994334"],
    callers: [
      {"path":"tests_js/migration_task_lineage_git_support.mjs","sha256":"d14bb06fd26f705d8ef1309efd92deecb8292fd719dd9f72079f80a3d1d3bf79"},
      {"path":"tests_js/migration_task_lineage_lifecycle.test.mjs","sha256":"550b46a665d01d21dacad0904000452ffe9985d0d071b8d5f420ed50eba7a8f0"},
      {"path":"tests_js/migration_task_replacements.test.mjs","sha256":"f265c3385c2fe3ac036689ec70147ed67cdb2d92933baad1045aa945179110ba"},
    ],
  },
];

async function observedPythonInventory(root, paths, hashes, select = PYTHON_SOURCE_PATH) {
  const inventory = [];
  for (const path of ordered(paths).filter(select)) {
    try {
      const sha256 = digest(await readRegular(root, path)); hashes.set(path, sha256);
      inventory.push({ path, sha256 });
    } catch { return 'unreadable'; }
  }
  return digest(JSON.stringify(inventory));
}

const NATIVE_PROVIDER_RECIPES = [
  {
    "path": "tests_js/posix_timestamps.test.mjs",
    "sourceSha256": "d7b6d83f09c440b399245ea7aa65ff17efdf72e2177f787163a8bdeb9cb4d801",
    "callHashes": [
      "62fce772e49952bdaec7961d93cf4d6759eddaf593875bbe5f5ed13530aba923"
    ],
    "builder": "tools/build-native-timestamps.mjs",
    "builderSha256": "f4aacb8a496b1f668760d04e7ec15a17f26f474e74063ff55f10766876dc780e",
    "callers": [
      {
        "path": "tests_js/posix_timestamps.test.mjs",
        "sha256": "d7b6d83f09c440b399245ea7aa65ff17efdf72e2177f787163a8bdeb9cb4d801"
      }
    ]
  },
  {
    "path": "tools/contracts/heavy-run-lease/reference.mjs",
    "sourceSha256": "70477cdd0ebab68a815451e05f3ce815d5417f5beb82a637c6fca6b3c3c30ecc",
    "callHashes": [
      "b741a3845598f98f5d41f22e436120d443b1e8ac3bdedb455b2027dbc91610fc",
      "b741a3845598f98f5d41f22e436120d443b1e8ac3bdedb455b2027dbc91610fc"
    ],
    "builder": "tools/build-native-lock.mjs",
    "builderSha256": "b49f30be5e89ac44facde30ccb7f7b60415199df451ee065f2161ee7f3387c80",
    "callers": [
      {
        "path": "tests_js/heavy_run_lease_reference.test.mjs",
        "sha256": "7beb599db422b36916a3ae4c6ced594e186840c099efff36021926a1721d472a"
      },
      {
        "path": "tools/contracts/heavy-run-lease/reference.mjs",
        "sha256": "70477cdd0ebab68a815451e05f3ce815d5417f5beb82a637c6fca6b3c3c30ecc"
      }
    ]
  }
];

const PROFILE_RECIPES = [
  {
    path: "tests_js/python-profile-fact-contracts.test.mjs",
    sourceSha256: "4a8b263eceede5a7a9a5b5ef32a4d3de492e9b572c50503a671f128451083d90",
    callHashes: ["3610fefdf5d5ea211c5b5cdc522ac0ec40782636eb9bff135c40712400801f17"],
    repositoryTargets: ["tools/contracts/profile-facts/driver.py"],
  },
  {
    path: "tools/contracts/profile-facts/capture.mjs",
    sourceSha256: "2d743b301bcb7699ecea5528a2984ead77c3eac508e358e71ddddfb50a3e9c8a",
    callHashes: ["5ca01c124f41483c2300c7386b0c47fd387e0acd7f3284105e077a2fc300e1b3"],
    repositoryTargets: ["tools/contracts/profile-facts/driver.py"],
  },
];

const LOCAL_PROCESS_RECIPES = [
  {
    identity: ["tests_js/exclusive_file_lock_fault_ts.test.mjs", "ccb93f9547b14d43540a414e22b091b93c57cd5c075d650173684bc5d960d450"],
    callHashes: ["381943d1da5dcd9699e246cb123de3065f9676e771c67e1846d2d47dd433411f"],
    python: false,
    repositoryTargets: ["scripts/job_apply_store/io.py", "tools/contracts/exclusive-file-lock/reference.py"],
  },
  {
    identity: ["tests_js/installed_artifacts_ts_support.mjs", "0d354fb690fb4475b21a849069c5ea288cce056c4b1c5bfd75567587fc617f76"],
    callHashes: ["05556d95046b5d99353391b601b645c155341bcbf115f189e3981210bbe2b308"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/local_checks_git.test.mjs", "e75701d90919f77104e4df01d1685378e15f83f7c5a74111741610fbb1a156ab"],
    callHashes: ["da90124ac638d842979e18bae21ffaa529e36cb7cdd7b0665c42a27d9d6f38a8"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/local_checks_install.test.mjs", "85bc37c452c1f2b4c77c03208a1bb37704a310100a5681f5d5e6d31dfe86bdf0"],
    callHashes: ["2255ff8bd775dd690a93c8c33b0f26302295d04ba9e31b2608aec66ca6065916", "476be71649d349c31f08f5c337403775a544d6c8942a7c0735810be393710af2", "5cb58df22127aa151a66bb0313d47294aaf596d5f55a1724ef1c160b03bf7d9d", "8cfa983e93fd08a5bc11df67356b47277326e087a9bd33d8dc0a7a3de497b3be"],
    python: false,
    repositoryTargets: ["tools/local-checks/git.mjs", "tools/local-checks/install.mjs"],
  },
  {
    identity: ["tests_js/local_checks_process.test.mjs", "b88f3c4674b135527a2451dbf6f77fa25d6255de40c65774b6c73eadc98147aa"],
    callHashes: ["66d560b43c5fa02d4c20ce9741bcfe20bdc16b4798895263ee41603102c43d43"],
    python: false,
    repositoryTargets: ["tools/local-checks/process.mjs"],
  },
  {
    identity: ["tests_js/local_checks_run.test.mjs", "d74866accb73a1f4b81c5a44d61789e23b5522065186fbad16a1ec9d8972c7ab"],
    callHashes: ["f6ffeb6205af9dae0a2af3549ac8caeb730241f492f95ca70ff9e0e803064447"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/migration_load_prerequisites.test.mjs", "31a5cd3502ebdbf866b04ab877f54148f270c9af9faee5b644bb9e2a3dc5a0e6"],
    callHashes: ["913f7f316ee973babeac4dd8ae88c31c6f70090465ef5a671eec67cad25cb8ed", "d87761c92a9ab6a8f309743a1a8476d9839374c68a61e8af278edbee9941af95"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/migration_inventory.test.mjs", "7c99fb8edbfc290d50935f708c2342cdfc962a1e158b550cbbd800adc945ced4"],
    callHashes: ["a0e4806b04044edd234c4cafd1f7d218b46bd3235fa1e10c46c0f3e9174bd690"],
    python: false,
    repositoryTargets: [],
  },
  {
    identity: ["tests_js/local_checks_run.test.mjs", "d0783f710b180efb9cb139c7c8b6faf8a53914d06f2c0ab10b057777bef610d8"],
    callHashes: ["f6ffeb6205af9dae0a2af3549ac8caeb730241f492f95ca70ff9e0e803064447"],
    python: false,
    repositoryTargets: [],
  },
 ].map(({ identity: [path, sourceSha256], ...recipe }) => ({
  path, sourceSha256, ...recipe,
}));
