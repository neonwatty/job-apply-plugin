import ts from 'typescript';
import { posix } from 'node:path';
import { isBuiltin } from 'node:module';
import { digest, SOURCE_SUFFIX } from './focused-contracts.mjs';

const LIMIT = 256;
const pathValue = value => value && typeof value === 'object' && typeof value.path === 'string';
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) && value.every(x => typeof x === 'string') ? value : null;
const kindFor = path => path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.jsx') ? ts.ScriptKind.JSX
  : /\.(?:ts|mts|cts)$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;

// A finite syntax interpreter, never JavaScript evaluation. Ambiguity stays unresolved.
export function analyzeSource(path, source, { depth = 0 } = {}) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, kindFor(path));
  const edges = [], calls = [], unresolved = [], imports = new Map(), scopes = new Map();
  let mutableExecutable = false;
  const problems = reason => unresolved.push({ path, reason });
  if (tree.parseDiagnostics.length) return { edges, calls, unresolved: [{ path, reason: 'invalid syntax' }] };
  function scopeOf(node, functionOnly = false) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isSourceFile(current) || ts.isFunctionLike(current)
        || !functionOnly && (ts.isBlock(current) || ts.isForOfStatement(current) || ts.isForStatement(current))) return current;
    }
    return tree;
  }
  function register(node, name, value, functionOnly = false) {
    const scope = ts.isParameter(node) ? node.parent : scopeOf(node, functionOnly);
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const bindings = scopes.get(scope);
    bindings.set(name, bindings.has(name) ? null : value);
  }
  function binding(node, name) {
    for (let current = node; current; current = current.parent) {
      const bindings = scopes.get(current);
      if (bindings?.has(name)) return { bindings, value: bindings.get(name) };
    }
    return null;
  }
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      register(node, node.name.text, node.initializer ?? (ts.isForOfStatement(node.parent?.parent) ? node.parent.parent.expression : undefined),
        ts.isVariableDeclarationList(node.parent) && !(node.parent.flags & ts.NodeFlags.BlockScoped));
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) register(node, node.name.text, undefined);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) register(node, node.name.text, undefined);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text, clause = node.importClause;
      if (clause?.name) imports.set(clause.name.text, { spec, name: 'default' });
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) imports.set(clause.namedBindings.name.text, { spec, name: '*' });
        else for (const item of clause.namedBindings.elements) imports.set(item.name.text, { spec, name: item.propertyName?.text ?? item.name.text });
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(tree);
  function mutations(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && /^(?:globalThis\.)?process(?:\.execPath|\[['"]execPath['"]\])$/.test(node.left.getText(tree))) mutableExecutable = true;
    if (ts.isCallExpression(node) && /^(?:Object\.(?:assign|defineProperty|defineProperties)|Reflect\.(?:set|defineProperty))$/.test(node.expression.getText(tree))
      && ['process', 'globalThis.process'].includes(node.arguments[0]?.getText(tree))) mutableExecutable = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) binding(node, node.left.text)?.bindings.set(node.left.text, null);
    if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && ts.isIdentifier(node.operand)
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) binding(node, node.operand.text)?.bindings.set(node.operand.text, null);
    ts.forEachChild(node, mutations);
  }
  mutations(tree);
  const expressionName = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text
    : node.kind === ts.SyntaxKind.ImportKeyword ? 'import' : null;
  function imported(node, allowed) {
    if (ts.isIdentifier(node)) {
      const binding = imports.get(node.text);
      return binding && allowed.includes(binding.spec) ? binding.name : null;
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = imports.get(node.expression.text);
      return binding && allowed.includes(binding.spec) && ['*', 'default'].includes(binding.name) ? node.name.text : null;
    }
    return null;
  }
  const moduleURL = node => ts.isPropertyAccessExpression(node) && node.name.text === 'url'
    && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  function evaluate(node, seen = new Set()) {
    if (!node || seen.size > 32) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (moduleURL(node)) return { path, url: true };
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return evaluate(node.expression, seen);
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return null;
      if (node.text === '__dirname' && !binding(node, node.text)) return { path: posix.dirname(path) };
      const next = new Set(seen); next.add(node.text);
      return evaluate(binding(node, node.text)?.value, next);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const values = [];
      for (const item of node.elements) {
        const value = evaluate(ts.isSpreadElement(item) ? item.expression : item, seen);
        if (ts.isSpreadElement(item)) { if (!Array.isArray(value)) values.push(null); else values.push(...value); }
        else values.push(value);
      }
      return values.length <= LIMIT ? values : null;
    }
    if (ts.isConditionalExpression(node)) {
      const a = evaluate(node.whenTrue, seen), b = evaluate(node.whenFalse, seen);
      if (typeof a === 'string' && typeof b === 'string') return [...new Set([a, b])];
      return null;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = evaluate(node.left, seen), b = evaluate(node.right, seen);
      return typeof a === 'string' && typeof b === 'string' ? a + b : null;
    }
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans) {
        const choices = strings(evaluate(span.expression, seen));
        if (!choices || values.length * choices.length > LIMIT) return null;
        values = values.flatMap(prefix => choices.map(choice => prefix + choice + span.literal.text));
      }
      return values.length === 1 ? values[0] : values;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      if (binding(node, 'URL')) return null;
      const spec = evaluate(node.arguments?.[0], seen), base = node.arguments?.[1];
      if (Array.isArray(spec) && spec.every(item => typeof item === 'string') && base && moduleURL(base)) {
        return spec.map(item => ({ path: item.startsWith('/') ? item.slice(1) : posix.normalize(posix.join(posix.dirname(path), item)), url: true }));
      }
      if (typeof spec !== 'string' || !base || !moduleURL(base)) return null;
      if (/^[a-z]+:/i.test(spec)) return { external: spec };
      return { path: spec.startsWith('/') ? spec.slice(1) : posix.normalize(posix.join(posix.dirname(path), spec)), url: true };
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'href') return evaluate(node.expression, seen);
    if (ts.isCallExpression(node)) {
      const alias = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : null;
      if (alias && binding(node, alias)) return null;
      const name = imported(node.expression, ['node:path', 'path', 'node:url', 'url']);
      const args = node.arguments.map(arg => evaluate(arg, seen));
      if (['fileURLToPath', 'pathToFileURL'].includes(name) && args.length === 1) return args[0];
      if (name === 'dirname' && args.length === 1 && pathValue(args[0])) return { path: posix.dirname(args[0].path) };
      if (['join', 'resolve'].includes(name) && args.length && args.every(arg => typeof arg === 'string' || pathValue(arg))) {
        const first = args[0];
        return { path: posix.normalize(posix.join(...args.map(arg => pathValue(arg) ? arg.path : arg))), root: !pathValue(first) };
      }
    }
    return null;
  }
  function add(spec, kind, base = 'module') {
    if (Array.isArray(spec)) { for (const item of spec) add(item, kind, base); }
    else if (pathValue(spec)) edges.push({ from: path, specifier: spec.path, kind, base: 'root' });
    else if (typeof spec === 'string') edges.push({ from: path, specifier: spec, kind, base });
    else problems(`unresolved ${kind}`);
  }
  function call(node, kind, resolution) {
    calls.push({ path, kind, expression: node.getText(tree), sha256: digest(node.getText(tree)),
      resolution, start: node.getStart(tree), value: evaluate(node.arguments?.[0]) });
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const bindings = node.importClause?.namedBindings;
      const typeOnly = node.isTypeOnly || node.importClause?.isTypeOnly
        || bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly);
      add(ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : null, typeOnly ? 'type-import' : 'static-module');
    }
    if (ts.isImportTypeNode(node)) add(ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
      ? node.argument.literal.text : null, 'type-import');
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const value = evaluate(node);
      if (pathValue(value) || Array.isArray(value)) add(value, 'module-or-data-url');
      else if (node.arguments?.[1] && moduleURL(node.arguments[1])) call(node, 'URL', 'unresolved');
    }
    if (ts.isCallExpression(node)) {
      const name = expressionName(node.expression);
      const loader = node.expression.kind === ts.SyntaxKind.ImportKeyword || name === 'require';
      const child = imported(node.expression, ['node:child_process', 'child_process']);
      const childBinding = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : null;
      const chained = ts.isCallExpression(node.expression)
        && imported(node.expression.expression, ['node:module', 'module']) === 'createRequire';
      if (loader || chained) {
        const value = evaluate(node.arguments[0]);
        if (pathValue(value) || typeof value === 'string') {
          add(value, 'literal-loader'); call(node, chained ? 'chained-createRequire' : name, 'resolved');
        } else call(node, chained ? 'chained-createRequire' : name, 'unresolved');
      } else if (child && ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync'].includes(child)) {
        if (binding(node, childBinding)) { call(node, child, 'unresolved'); ts.forEachChild(node, visit); return; }
        const args = evaluate(node.arguments[child === 'fork' ? 0 : 1]);
        const executable = evaluate(node.arguments[0]);
        const nodeExecutable = !mutableExecutable && !binding(node, 'globalThis') && !binding(node, 'process') && (!imports.has('process') || ['node:process', 'process'].includes(imports.get('process').spec)) && node.arguments[0]?.getText(tree).match(/^(?:globalThis\.)?process\.execPath$/)
          || executable === 'node' || child === 'fork';
        let resolved = false;
        if (nodeExecutable && (Array.isArray(args) || child === 'fork' && typeof args === 'string')) {
          const argv = Array.isArray(args) ? args : [args];
          const inline = argv.findIndex(value => value === '-e' || value === '--eval');
          if (inline >= 0 && argv.slice(0, inline).every(value => ['--input-type=module', '--no-warnings'].includes(value))
            && typeof argv[inline + 1] === 'string' && depth < 2) {
            const nested = analyzeSource(path, argv[inline + 1], { depth: depth + 1 });
            edges.push(...nested.edges); unresolved.push(...nested.unresolved); calls.push(...nested.calls);
            resolved = nested.unresolved.length === 0 && nested.calls.every(item => item.resolution === 'resolved');
          } else {
            const leading = argv.findIndex(value => typeof value !== 'string' || !value.startsWith('-'));
            const flags = argv.slice(0, leading);
            const entry = argv[leading];
            if (leading >= 0 && flags.every(value => ['--test', '--no-warnings'].includes(value))
              && (pathValue(entry) || typeof entry === 'string' && SOURCE_SUFFIX.test(entry))) {
              add(entry, 'literal-child-process', 'root'); resolved = true;
            }
          }
        }
        call(node, child, resolved ? 'resolved' : 'unresolved');
      } else if (name === 'exec' && ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;
        const expression = ts.isIdentifier(receiver) ? binding(receiver, receiver.text)?.value : receiver;
        if (!expression || expression.kind !== ts.SyntaxKind.RegularExpressionLiteral) call(node, name, 'unresolved');
      } else if (imported(node.expression, ['node:module', 'module']) === 'createRequire') {
        if (!moduleURL(node.arguments[0])) call(node, 'createRequire', 'unresolved');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { edges, calls, unresolved };
}

export function resolveEdge(edge, tracked, packages = new Set()) {
  const spec = edge.specifier;
  if (edge.base === 'module' && !spec.startsWith('.') && !spec.startsWith('/')) {
    if (isBuiltin(spec) || packages.has(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'))) return { external: spec };
    return { error: `unresolved external import ${spec}` };
  }
  const target = edge.base === 'root' ? posix.normalize(spec) : spec.startsWith('/') ? spec.slice(1)
    : posix.normalize(posix.join(posix.dirname(edge.from), spec));
  if (target.startsWith('../') || target.startsWith('/') || target.includes('\\')) return { error: `external target ${spec}` };
  let candidates = [target];
  if (edge.from.startsWith('src/') && target.endsWith('.js')) candidates = [target.slice(0, -3) + '.ts', target];
  if (!posix.extname(target)) candidates.push(...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'].map(ext => target + ext),
    ...['index.js', 'index.mjs', 'index.ts'].map(name => target + '/' + name));
  const present = candidates.filter(path => tracked.has(path));
  if (!present.length && edge.kind === 'module-or-data-url' && (['.', './'].includes(target) || [...tracked].some(path => path.startsWith(target.replace(/\/$/, '') + '/')))) return { directory: target };
  if (!present.length && target.startsWith('node_modules/') && packages.has(target.split('/')[1])) return { external: target };
  if (!present.length) return { error: `missing target ${target}` };
  if (present.length > 1 && !(edge.from.startsWith('src/') && target.endsWith('.js'))) return { error: `ambiguous target ${target}` };
  return { path: present[0] };
}

// Observe identifier uses without executing code or assuming a namespace/forwarder is safe.
export function inspectRunnerBindings(path, source, protectedModules) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, kindFor(path));
  const bindings = [], issues = [];
  const targetOf = spec => spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(path), spec)) : spec;
  for (const statement of tree.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = targetOf(statement.moduleSpecifier.text), names = protectedModules.get(target);
    if (!names) continue;
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)
        || statement.exportClause.elements.some(item => names.includes(item.propertyName?.text ?? item.name.text))) {
        issues.push(`Runner reexport: ${path}`);
      }
      continue;
    }
    const clause = statement.importClause;
    if (clause?.name || clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      issues.push(`Runner namespace/default escape: ${path}`); continue;
    }
    for (const item of clause?.namedBindings?.elements ?? []) {
      const importedName = item.propertyName?.text ?? item.name.text;
      if (!names.includes(importedName)) continue;
      const uses = [];
      function visit(node) {
        if (ts.isIdentifier(node) && node.text === item.name.text && node !== item.name && node !== item.propertyName) {
          const parent = node.parent;
          if (ts.isPropertyAccessExpression(parent) && parent.name === node
            || ts.isPropertyAssignment(parent) && parent.name === node) return;
          const kind = ts.isCallExpression(parent) && parent.expression === node ? 'call' : 'escape';
          uses.push({ kind, expression: parent.getText(tree), sha256: digest(parent.getText(tree)) });
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      bindings.push({ target, importedName, localName: item.name.text, uses });
    }
  }
  return { bindings, issues };
}

// Closed dispatcher/caller identities; additions and edits require renewed finite review.
export const RUNNER_MODULES = new Map([
  [
    "tools/test-runner/process.mjs",
    [
      "runCapture",
      "runStreaming"
    ]
  ],
  [
    "tools/local-checks/process.mjs",
    [
      "runLocalCommand"
    ]
  ],
  [
    "tools/local-checks/git.mjs",
    [
      "git"
    ]
  ],
  [
    "tools/test-runner/execute.mjs",
    [
      "executeSuites"
    ]
  ],
  [
    "tools/contracts/profile-facts/capture.mjs",
    [
      "captureCorpus",
      "main"
    ]
  ]
]);
export const RUNNER_IDENTITIES = [
  {"path":"tests_js/local_checks_git.test.mjs","sourceHash":"e75701d90919f77104e4df01d1685378e15f83f7c5a74111741610fbb1a156ab","bindingHash":"88aac17ffbe7d84b61004dbf3104bc31a95463ca0685469eff977f29c15835aa"},
  {"path":"tests_js/local_checks_install.test.mjs","sourceHash":"85bc37c452c1f2b4c77c03208a1bb37704a310100a5681f5d5e6d31dfe86bdf0","bindingHash":"31dd7449c66934f0c0f613197ae235bff90992fa617b4da2ec0834edddb50a41"},
  {"path":"tests_js/local_checks_process.test.mjs","sourceHash":"b88f3c4674b135527a2451dbf6f77fa25d6255de40c65774b6c73eadc98147aa","bindingHash":"1a4e9fb73814e1931c534713b314e1d7369c6d204a722a9018fc6c66e8956820"},
  {"path":"tests_js/python-profile-fact-contracts.test.mjs","sourceHash":"4a8b263eceede5a7a9a5b5ef32a4d3de492e9b572c50503a671f128451083d90","bindingHash":"b326987d6b6e7cc6bbb0ad142d41664f83750e00be8ea816b58f481a15c00ef6"},
  {"path":"tests_js/test-runner-execution.test.mjs","sourceHash":"7728c34652ca2d88464994e1c51317587e5e2d152d0fd4765599721c1e47df43","bindingHash":"a372c20a1272d2bdefb39d8aa61fa20a7d2a11fce30ab46c733d8f074169e94c"},
  {"path":"tools/ci/run-suite.mjs","sourceHash":"eba07735daa67e07d521e51d1513ef42d5e61ae8da681689d57162fa27de05a6","bindingHash":"3494a52a3e2872e4625f2beeeba03187b058e4d71356309a751cc55e110f97dd"},
  {"path":"tools/contracts/profile-facts/capture.mjs","sourceHash":"2d743b301bcb7699ecea5528a2984ead77c3eac508e358e71ddddfb50a3e9c8a","bindingHash":"df2431eb4b6fd5e76c919d21489cba60ee511418d71582fac65496b3ee3b9d92"},
  {"path":"tools/local-checks/git.mjs","sourceHash":"d48fc04f3e7fe434f9fd6a0efe00306b0d5947678d4023aba8d2c13913cc2c32","bindingHash":"df2431eb4b6fd5e76c919d21489cba60ee511418d71582fac65496b3ee3b9d92"},
  {"path":"tools/local-checks/hook.mjs","sourceHash":"ea45841e55dc639d5341ff4f93642cfd95f9ecc4523be15f752168bae39491e1","bindingHash":"76ec009f119d1c7799d5ca6d1d87e29567beb5428149e91eb773ee52d6871848"},
  {"path":"tools/local-checks/install.mjs","sourceHash":"47bac92307376fd46f9948f1df4226cd51424f232dee1bc31945a971be8ecb8e","bindingHash":"69fdae8486b61a62d25129d833f13cd7dae5efd98775a341a8aa33d4fbe2c7ad"},
  {"path":"tools/local-checks/links.mjs","sourceHash":"835e66865c6882d01314d3bfc3eeb7427d1ee1032bc10cec7380d9d00e312266","bindingHash":"45c864c4243583fd3cf8a0f3220e8d2547ac9c93e1dd3dcd159a6a5abe2437ed"},
  {"path":"tools/local-checks/process.mjs","sourceHash":"5a9bcd74638a9c2b89e69ae2730710a2ddac02906159b3ae8d012386e4f257db","bindingHash":"df2431eb4b6fd5e76c919d21489cba60ee511418d71582fac65496b3ee3b9d92"},
  {"path":"tools/local-checks/run.mjs","sourceHash":"3d109666337f7f650f903fdd6f455d86f2b84c6b286e605fe845b6c0fbf8cfcd","bindingHash":"1e9932c006cf47e61434ffe0bb8c3839a772c5ceb3562f007c42b45de546d8c7"},
  {"path":"tools/test-runner.mjs","sourceHash":"26dfa5444ac3f454cc41aadc03a8dad81d9e1d16f058b9c129279b714d7b41e6","bindingHash":"4ea31b146dd2eea3941e97373fbebc3dbcdcbcd219f578941d2ba6745e2b7126"},
  {"path":"tools/test-runner/execute.mjs","sourceHash":"ba8bbdfdfb2c6569e639351d00ce7eccae8fd8c0655b9053baebb52f69750568","bindingHash":"5cdccfa90741a03d792d9a204b947f2c69e7d713396e482d110ee2615984d6df"},
  {"path":"tools/test-runner/git.mjs","sourceHash":"78097d57073dc0ab2057f783e467b9af2720738e8c9a8b73e96caa919f6f07bf","bindingHash":"d7082ace01d6dfb0a1e745c0e5f13ab79d345905c2842506f8c5c54b9a7a8b09"},
  {"path":"tools/test-runner/matrix.mjs","sourceHash":"eb88ff392a5fbd0de5b27042d83471b91f2324a29e5912211fbd9e07b6279727","bindingHash":"df2431eb4b6fd5e76c919d21489cba60ee511418d71582fac65496b3ee3b9d92"},
  {"path":"tools/test-runner/patterns.mjs","sourceHash":"6eb05de69ce7e7531d9a8cc90f628180b05891bc2eaa7f9fa711570dbb730ac2","bindingHash":"df2431eb4b6fd5e76c919d21489cba60ee511418d71582fac65496b3ee3b9d92"},
  {"path":"tools/test-runner/process.mjs","sourceHash":"b9eea8bec5e3bb21a4bcb820c83414b798b7f25c336b1b639c2f179ca0c13d17","bindingHash":"df2431eb4b6fd5e76c919d21489cba60ee511418d71582fac65496b3ee3b9d92"},
];

// Reviewed executable driver bytes: a new body requires renewed finite dependency proof.
export const EXECUTABLE_TARGET_HASHES = {
  "scripts/skill_documents.py": "06831df10f967087c5980b437e7425db0998e6ab6f39ecefd84a12156d6550c2",
  "workspace/index.html": "b5b535acbd2e3cd7fce6a39698bf7a27daa5a33c9cb09fed35139690e5ac5930",
  ".githooks/pre-commit": "54c1b6338bea7662f2a4105ef7bcb88496ce086a2d54442f51406d822a4aeab9",
  ".githooks/pre-push": "81492a6a7f342bd482e07d60d8debc60eb4e10f1a50ed36971972ad35dbd5a4b",
  "docs/migration/evidence/s08/additional-reference-vectors.json": "500ce6a2f35ac9f9e0bfe9ec8a676d0aa1165687a768f53e3bffeacf5048225d",
  "docs/migration/evidence/s08/composed-reference-vectors.json": "1ccb7cdb553cd70a1f6107904b595c4a9c9ea720e9d8c5cbc48955233f280e7b",
  "qa/__init__.py": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "qa/contracts.py": "318b651e0d3584f09822112a86988561ee7a2bf3d3215c3325386f96364751a8",
  "qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json": "c999101345bfce65c051bceea7435a9abf7ff054bceb53f2a668a83436ceae30",
  "qa/recorder_broker.py": "6c97630ee2d005cbfd0d7039e99efa4f66d7f814bf1b870702c0e32a2eb78164",
  "qa/recorder_fs.py": "c6348f3e80f55512c962a32d742ff254dcfe267298a0a70a65f7bf22b93f01c2",
  "qa/recorder_fs_ops.py": "74065d217cee59f5de8107ca96d47ff659569b0f3465eda672b2a6455bb441c5",
  "qa/recorder_guardian.py": "51ed424c802245105173ad3255feaf9e6e589341acd43f9f7a4b9dc449873358",
  "qa/renderer/index.html": "e8712f68b72db688e490f1f56ddc99bdde4e2f5f217b2431b5a3bec73079e34e",
  "qa/renderer/styles.css": "c1aad0ca4b7036fa0c755b6dcc6d583e95eadcf79e15c5039d23f62241502eef",
  "qa/server.py": "744eb85fcaa6b6d6c50d7b5b8dc7fc5b0330fb01fff84a189dcae817ec360090",
  "qa/server_auth.py": "49e398f642df20b989f6aaf6a1c32b0093a7bce31833e6d2e9cd2ed0f7861816",
  "qa/server_events.py": "68f0129ec19e9f18dcb3e1b2692d8469da95acca72d43f0e0fcfc850b2fe454e",
  "qa/server_final_action.py": "73fd68f271798b64973aad1e5dc12882434dd306642414bc546a08521addbd57",
  "scripts/job-apply-attempt.py": "113002dbe0327900498fc89dd4dd7bdc86f0bcc7cdb09c683c046961fef2636d",
  "scripts/job-apply-store.py": "a02a0d65c67e067575838a0aa7bfabac0b2beaf10364e0bcfc23b3dbd1094ce2",
  "scripts/job-apply-task.py": "0aef070d368994f4ab2e96d4ddd23172f46597e870ee97fc9dfff9e6af6b10d1",
  "scripts/job-apply-workspace.py": "6cc150b052e0b8c75f0a52328f9c79297b8ca6777839676e10e722f49840ed78",
  "scripts/job_apply_policy.py": "b20b45c19ae91ea7a5d1b1410720d31c235e8734bfbf5379fb7bdb4c781cef93",
  "scripts/job_apply_store/constants.py": "4438a36055842e18af0ae806fed1f61bf8280908995f7295662a4213226e8b5c",
  "scripts/job_apply_store/domains/coordinator/persistence.py": "1296863bad9412b852879a3b9c653a98ca61375811df2690600e6f69bc7c3177",
  "scripts/job_apply_store/domains/resumes/storage.py": "97ec178e0b3ddc1d3be97b1c6c34983ecf9c50caa9c6f4fd4125dbb71c6db6fe",
  "scripts/job_apply_store/domains/sessions/history.py": "3d0b6cac869f0ec745f80bc3c9a65eda0460818c9f0b0c0e50b3b9ba57bf049f",
  "scripts/job_apply_store/io.py": "6e4b36c224fdf34924f14fecbd6d8afaf398afcff455509b85a817008c407d53",
  "scripts/job_apply_store/normalization.py": "8c299675838779908a1d3876db22fc2d9b32a2e08a890246357193b1d20b2beb",
  "scripts/job_apply_store/validation/sessions.py": "9d1c6158facc0724e5500defbc8027931e2112927677d9f3b79d5a8fde5339ce",
  "scripts/job_apply_workspace/__init__.py": "cc5a9faef05e7d0db633383f2bb6feb3b45ac51cb860c962db7afeb8c59137c2",
  "scripts/job_apply_workspace/http.py": "122cb3f0d2eb0833e30d88a75cfb071842990c5984b47c18b950f4aa2f015a33",
  "scripts/qa-chrome.py": "1ba55507596b6ebac569b57fd8ca004353f87c6004166939e339b42558cd42ea",
  "scripts/smoke/artifacts.py": "ff7c63a8a33cde557c8f6d3f90489daa20536c710b75f2d08d9ab9c91a479306",
  "tools/contracts/answer-matching-raw/reference.py": "d6679d9c9b638627b9799a38491fa03296fec9c92234b7fb26610773dcc30c17",
  "tools/contracts/artifact-copy-metadata/reference.py": "f07ae9a272262b9f3661c2e7fea9d56546730302e8a9a3343166b8a81d4536c2",
  "tools/contracts/artifact-copy-metadata/support.py": "70720d55b56f865a126985ba59ce273724063ae8b687e47331ee3fe86b4e73b6",
  "tools/contracts/artifact-copy-order/reference.py": "7cce21279e7a4954ed225d3c60819287b4c103fffd4123f60b7f5851c1aec6d7",
  "tools/contracts/artifact-copy-order/support.py": "50a05cc3628cc4ffd35786e45d30f5138fca44af7335b91e3f47ee86b8ac8781",
  "tools/contracts/artifact-data-copy/reference.py": "2d386119d0685bdc94c22cfc1a05e77a0f5580fbfe6e14f83fee7e047b0f3d12",
  "tools/contracts/artifact-data-copy/support.py": "33e9a45c0409d78d77507d45bd6131a73c372852f32c023a36a8fc5002cc1116",
  "tools/contracts/atomic-write-json/reference.py": "283e45f35c5485a645fa71844958749e541108be5b55cad6a76fcc8687182381",
  "tools/contracts/codepoint-json/reference.py": "fef264468e9190a80cd6edbc03ec06693f6269edc3df7f30757fb16a8d63c231",
  "tools/contracts/exclusive-file-lock/reference.py": "fd3f0416e5b7d8d7537fc00aa337bd280b962ec0feaa5dd1b39b89850d9e8c74",
  "tools/contracts/history-read-idempotency/reference.py": "da5edbca1648c4c9c67a82bda99c2d1f26d87272c1ba80da1517cad3fb88926b",
  "tools/contracts/history-read-idempotency/support.py": "3ee7f2241104f5c885e5f379b9b08ba0f109f763b77580c1c7db4075d8907e89",
  "tools/contracts/http-json-bytes/reference.py": "5c363333f8a63cc70850a322a2ca7ee56e88c156fe7515c87df1d8be72105070",
  "tools/contracts/http-json-bytes/support.py": "f798d06c1f11b0c1695fb747e83d91ca0bcff617e286d47160cb849dc6420dd2",
  "tools/contracts/installed-artifacts/reference.py": "c99f2cd8136f577a23facb49a0fd6e1774b253b144066e848d0f76ec66e35079",
  "tools/contracts/installed-artifacts/support.py": "4285a53a13ff7eca257c98fa5b77ede001c639eaaf24908458638fdc00421b38",
  "tools/contracts/json-ingress/reference.py": "74c364470fc3b4468831403d42451a735b1e88c333f3ecf0d77204b12e39dc32",
  "tools/contracts/json-ingress/stdin-reference.py": "a61b3987b3a114c8b4dc761a054cd7bd2db3be4f70c2e04d2abe551ca59beadb",
  "tools/contracts/jsonl-append/reference.py": "6a877e92fb9c0ecbbcc19a76e4f15b4dd1f4112304c2c7b7aed2958647783d13",
  "tools/contracts/managed-observation/native.py": "bf00ae00da09b75cff6da59e5450efb5acfc71a747d48bff1b06fb1f67e6431d",
  "tools/contracts/managed-observation/reference.py": "d6b170e99a986c5d1a15a134bc6044cd559fa06d2c5381d90d3b49ec104e7a0b",
  "tools/contracts/managed-resume-path/reference.py": "133a81e18fdbe0265fd49c2908fa79831fc3d1cd958a23e40bbc702ec36a7de4",
  "tools/contracts/posix-path-bytes/reference.py": "5a51271c11cf812328d31d9864c736bbbdf8bb80e2c27db17d266073c2855325",
  "tools/contracts/private-file-digest/reference.py": "7dba1564bd23b7659b33550a2eff3f2582794bdac714a50205f40e2ac554b783",
  "tools/contracts/profile-facts/driver.py": "f8dafd84dc60365c02b8fb869922ed0e0b4ad33580610a0d20a3d89662717f5b",
  "tools/contracts/python-json-bytes/reference.py": "a5b14b176b3ee2b9a21c3366a49cf07239d8e057aa3bfb897c20bf5f502bc428",
  "tools/contracts/python-object/reference.py": "9538767aa71e347c3d9c39165ab364869c11bd8d7994fa3b4801d1893372dbc9",
  "tools/contracts/python-text/reference.py": "1e661e4071274822cb2a7570ad98f5e76b24731f9c26aeef00cd3773c89c0286",
  "tools/contracts/raw-json-numeric/reference.py": "4a4ced03803336da39b91b92c9220b46acbe1e77a0e52c527241e763dbd95d9d",
  "tools/contracts/resume-modified-at/reference.py": "80438c80fc503d051663d5bcc08fb31a1eee96cb9b35e1b94358f4a0d5c5fbb5",
  "tools/contracts/store-raw-read/reference.py": "0ff189e5d3dd557f026758420f6bf81282021aa9dda3f328f8e0a9083bc6d6cb",
  "tools/contracts/store-validation/reference.py": "8dcf74908a7e48b1bcf930e9f577cb132b36d20a4b0782355ede9eaa38330526",
  "tools/contracts/typed-json/reference.py": "e8bf37732da03743430c35740296a26d19985e32958697826f32e6ae274b03cb"
};

export const CALLER_PROCESS_RECIPES = [
  {
    path: "qa/recorder/broker-client.mjs",
    sourceSha256: "bf273e6bb9ac43a33da640c2645008e410825a9540d01581ecaf64c8919f2c26",
    callHashes: ["af907541e8c43b45e4678316993e083ae8231dc2df0fcf18f861a105703f453b"],
    python: true,
    repositoryTargets: ["qa/recorder_fs.py","qa/__init__.py","qa/recorder_broker.py","qa/recorder_fs_ops.py","qa/recorder_guardian.py"],
    callers: [
      {"path":"qa/recorder.mjs","sha256":"c339ef0e6aa9f0ea9c05018712810bd8b6c9e2adca4c0cb92309056a2a7bd774"},
      {"path":"qa/recorder/broker-client.mjs","sha256":"bf273e6bb9ac43a33da640c2645008e410825a9540d01581ecaf64c8919f2c26"},
      {"path":"qa/recorder/capture.mjs","sha256":"3301dce3952593e97c1e4a7407e5680e39d6bda2f0cf5b78cac3dde420b053e1"},
      {"path":"qa/recorder/checkpoint.mjs","sha256":"0a15cfbe2ee4012d5f343cf5bfca39bd290b39e04cc0a316f901d074a93a9270"},
      {"path":"qa/recorder/cli.mjs","sha256":"ced6f8e1c001c9b25ad3eadd872cfbd42a32870f1ded14ca461bd9e54ed5dbab"},
      {"path":"qa/recorder/record.mjs","sha256":"97fffcc74c591e50e5cf189cce0438b2ca29f6f52c46861f04f61aed4b096c75"},
      {"path":"tests_js/recorder.test.mjs","sha256":"2a4e858afb57f0ab3bc1f87a7c5efe21e04854b2ec48597229fae939d70cfa45"},
      {"path":"tests_js/recorder_ats_safety_greenhouse_ashby.test.mjs","sha256":"4d13162c904c0ea767424a628c891eda5223fda6d842c99f6cc3154dd42ddae4"},
      {"path":"tests_js/recorder_ats_safety_lever.test.mjs","sha256":"1113466320ba689932a694a09f58e6d2a3124752746dab33abb0e9bba3e574e5"},
      {"path":"tests_js/recorder_ats_safety_workday_linkedin.test.mjs","sha256":"154ae4e62b342576e8dd2de060673034b879705c5aea6f42950a753bfaa6a8e8"},
      {"path":"tests_js/recorder_broker.test.mjs","sha256":"b93a85414d0079ab64437fbaaa54bf5a6118a0ffa90b0564af3b4f63ddf9c136"},
      {"path":"tests_js/recorder_capture_browser.test.mjs","sha256":"b7e07e463819c5c5db08c6449e3c1f6a9ba3a25c665476e034d5c14683b30d0f"},
      {"path":"tests_js/recorder_capture_checkpoint_scenario.test.mjs","sha256":"b9da98761f12315d0a4076ac3e891b918d9b3fec5a08d69e1cf0ea7c67a8c95b"},
      {"path":"tests_js/recorder_capture_safety.test.mjs","sha256":"305f4812eecb82e272cea0282481ae3abb824793bfdfa3e15b83822897557720"},
      {"path":"tests_js/recorder_capture_unit.test.mjs","sha256":"e467832292d6c25bbf33279988fb58297df6e9fa5bae3fc3faddc84e47eaab8d"},
      {"path":"tests_js/recorder_capture_workday.test.mjs","sha256":"0d54f3d4812f78d0c3e4949df0daa7c9e41f9e978005b3c83c0982f575390cc4"},
      {"path":"tests_js/recorder_checkpoint_basics.test.mjs","sha256":"c552165fe236c1c8eada521af758b5ea05f1d7bcd18492fa44568b5a5cfa4174"},
      {"path":"tests_js/recorder_checkpoint_client.test.mjs","sha256":"3bc8ea66ec9539763fea8223744e79dd17c608118cdb9516abe0a2c49af0aa6b"},
      {"path":"tests_js/recorder_facade_contract.test.mjs","sha256":"739a54ef67ee17c7c72c07cb5b09162e5e01fb30011dddf0ae18c3d4e61e91f4"},
      {"path":"tests_js/recorder_lifecycle_signals.test.mjs","sha256":"fdcb354e506b270040d904f883fe0873454fcaf481d6b22002d27e49917b52b7"},
      {"path":"tests_js/recorder_png_resources.test.mjs","sha256":"b8aa88bacd0a1c03034c8e68b34d7ad96a84f744b92ca26888a5848e163db7a9"},
      {"path":"tests_js/recorder_test_support.mjs","sha256":"72ad22b18cd4759dd151d68ede19b6f1b707e915547ca293194c1cf4c2bce00e"},
    ],
  },
  {
    path: "qa/unified_task_spine_oracle.mjs",
    sourceSha256: "fae3fff219659d00ae221ebd781e801e25d78ba418a4909e30030c9b53171a8d",
    callHashes: ["ec6623854b7a5cff3c421739690f316e44f22e55cfb8d2b87cfa47dcbe70061b","b84ee9a20424a743bddb1116e1db8443952c8bf398334a98200255f30a874aa3","9b21679ca89b7d9eeb352d6072f9d4cb807820356c0624ab2af431114ea1b4dd"],
    python: true,
    repositoryTargets: ["scripts/job-apply-store.py","scripts/job-apply-task.py","scripts/job-apply-attempt.py","scripts/job-apply-workspace.py","workspace/app.js","workspace/index.html","workspace/styles.css"],
    requiredSourceBindings: [{"path":"workspace/index.html","sha256":"b5b535acbd2e3cd7fce6a39698bf7a27daa5a33c9cb09fed35139690e5ac5930"}],
    callers: [
      {"path":"qa/unified_task_spine_oracle.mjs","sha256":"fae3fff219659d00ae221ebd781e801e25d78ba418a4909e30030c9b53171a8d"},
      {"path":"tests_js/unified_task_spine_oracle.test.mjs","sha256":"52a8801c0dd0e45a17d5c2697556cc7aa2c8187f1afd76d8a1c05f8fe726a1b2"},
    ],
  },
  {
    path: "tools/contracts/python-store.mjs",
    sourceSha256: "0d82fe74aadf2f44e272b9a37297ad96c718aa076bc2f7c9e52dc70dc593c614",
    callHashes: ["0ede9296d3076f47c9e48e1d9de31bcf41eb872ed7149725afcbc0d7174ab111"],
    python: true,
    repositoryTargets: ["scripts/job-apply-store.py"],
    callers: [
      {"path":"tests_js/python-contracts.test.mjs","sha256":"c0119f1b3c42ff30f3091eda6ccc984ecc369cac7127aeb9357f4cb04af5f559"},
      {"path":"tests_js/python-startup-contracts.test.mjs","sha256":"002846cbfa46a10f68533adaeae2e734c2630c5753df499cf7a4dd0df4b27594"},
      {"path":"tools/capture-python-contracts.mjs","sha256":"eeef9c29de26470d434d142d246086eec848289a3a12d40027f75c8577c9d5bc"},
      {"path":"tools/contracts/capture-read-corpus.mjs","sha256":"5b839ff34797f2bf47b693a0f33ccd1e12a2f353472ddef245e6d7d7f43c9985"},
      {"path":"tools/contracts/capture-startup-read-corpus.mjs","sha256":"c3ed6622291c807e33c55a16fe3b60038fa37bac1199632241c0c36e5bc20671"},
      {"path":"tools/contracts/owned-store-fixture.mjs","sha256":"25db08c76ff14b64db0c4fc231abdd5850990228e60bfce6f45d75d7c3df5ffa"},
      {"path":"tools/contracts/python-store.mjs","sha256":"0d82fe74aadf2f44e272b9a37297ad96c718aa076bc2f7c9e52dc70dc593c614"},
    ],
  },
  {
    path: "tests_js/exclusive_file_lock_support.mjs",
    sourceSha256: "c79cc94f9e61f1692bfa3109e59eab12a56bc479d9e69c24fc0fbbda9f23b9f9",
    callHashes: ["fd814c28eea4f3e6555a0b3a493b95df7cf136d35f65d8772fcdab2d85f44ad5"],
    python: false,
    repositoryTargets: ["runtime/store/posix-flock.js","runtime/store/exclusive-file-lock.js","runtime/store/jsonl-history.js","runtime/store/jsonl-history-io.js","tools/build-native-lock.mjs"],
    requiredSourceBindings: [{"path":"tools/build-native-lock.mjs","sha256":"b49f30be5e89ac44facde30ccb7f7b60415199df451ee065f2161ee7f3387c80"}],
    callers: [
      {"path":"tests_js/exclusive_file_lock_fault_ts.test.mjs","sha256":"ccb93f9547b14d43540a414e22b091b93c57cd5c075d650173684bc5d960d450"},
      {"path":"tests_js/exclusive_file_lock_support.mjs","sha256":"c79cc94f9e61f1692bfa3109e59eab12a56bc479d9e69c24fc0fbbda9f23b9f9"},
      {"path":"tests_js/exclusive_file_lock_ts.test.mjs","sha256":"df276a59d49fbf807147f156068a494311bca0956025e446aee7a96f937023c6"},
      {"path":"tests_js/jsonl_lock_integration.test.mjs","sha256":"9ee1797470b5b5fe44e89799f0b7ae30c0aa5f5753d8b612e9d998926f8748d4"},
      {"path":"tests_js/posix_flock.test.mjs","sha256":"792cd98f4502b6e72f43572259ad38059614d175a364ab366e48a474f00c81fd"},
    ],
  },
];
