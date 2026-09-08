import ts from 'typescript';

const platforms = new Set(['win32', 'darwin', 'linux', 'aix', 'freebsd', 'openbsd', 'sunos', 'android']);
function bindingNames(name, result = []) {
  if (ts.isIdentifier(name)) result.push(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name, result);
  }
  return result;
}
function importedNames(statement) {
  const clause = statement.importClause;
  const result = clause?.name ? [clause.name.text] : [];
  const bindings = clause?.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) result.push(bindings.name.text);
  if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) result.push(item.name.text);
  return result;
}
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
}
function processReference(node) {
  return ts.isIdentifier(node) && node.text === 'process'
    || memberName(node) === 'process' && ts.isIdentifier(node.expression)
      && ['global', 'globalThis'].includes(node.expression.text);
}
function rootedAtProcess(node) {
  if (processReference(node)) return true;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return rootedAtProcess(node.expression);
  return false;
}
// This deliberately rejects known writes and escapes, not arbitrary imported effects.
function conditionalSafe(tree, aliases) {
  for (const statement of tree.statements) {
    let bound = [];
    if (ts.isImportDeclaration(statement)) {
      bound = importedNames(statement);
      if (statement.moduleSpecifier.text === 'node:test') bound = bound.filter(name => !aliases.has(name));
    } else if (ts.isVariableStatement(statement)) {
      bound = statement.declarationList.declarations.flatMap(item => bindingNames(item.name));
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) bound = [statement.name.text];
    if (bound.some(name => name === 'process' || aliases.has(name))) return false;
  }
  let safe = true;
  function hoisted(node) {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)
      && node.declarations.flatMap(item => bindingNames(item.name)).some(name => name === 'process' || aliases.has(name))) safe = false;
    ts.forEachChild(node, hoisted);
  }
  hoisted(tree);
  function mutationTarget(node) {
    if (rootedAtProcess(node)) return true;
    let found = false;
    ts.forEachChild(node, child => { if (mutationTarget(child)) found = true; });
    return found;
  }
  function visit(node) {
    if (!safe) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && mutationTarget(node.left)) safe = false;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
      && rootedAtProcess(node.operand)) safe = false;
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && mutationTarget(node.initializer)) safe = false;
    if (ts.isDeleteExpression(node) && rootedAtProcess(node.expression)) safe = false;
    const globalReference = ts.isIdentifier(node) && ['global', 'globalThis'].includes(node.text);
    if (processReference(node) || globalReference) {
      const parent = node.parent;
      const isMemberRead = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
      const isPropertyName = ts.isIdentifier(node) && (ts.isPropertyAccessExpression(parent) && parent.name === node
        || ts.isPropertyAssignment(parent) && parent.name === node && !parent.name.questionDotToken);
      const isBinding = ts.isVariableDeclaration(parent) && parent.name === node
        || ts.isParameter(parent) && parent.name === node;
      if (!isMemberRead && !isPropertyName && !isBinding) safe = false;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return safe;
}
function literalTimeoutOptions(node) {
  if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 1) return false;
  const property = node.properties[0];
  if (!ts.isPropertyAssignment(property)
    || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
    || property.name.text !== 'timeout'
    || !ts.isNumericLiteral(property.initializer)) return false;
  const timeout = Number(property.initializer.text);
  return Number.isSafeInteger(timeout) && timeout > 0;
}
function directName(statement, aliases) {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return undefined;
  const call = statement.expression;
  if (!ts.isIdentifier(call.expression) || !aliases.has(call.expression.text)) return undefined;
  const name = call.arguments[0];
  const callback = call.arguments.length === 3 ? call.arguments[2] : call.arguments[1];
  if ((call.arguments.length !== 2
      && !(call.arguments.length === 3 && literalTimeoutOptions(call.arguments[1])))
    || !name || !ts.isStringLiteral(name) || !callback
    || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return undefined;
  if (ts.isBlock(callback.body) && !callback.body.statements.length) return undefined;
  return name.text;
}
function selectedBranch(statement, platform, aliases) {
  if (!ts.isIfStatement(statement) || !ts.isBinaryExpression(statement.expression)
    || !ts.isBlock(statement.thenStatement) || !statement.elseStatement || !ts.isBlock(statement.elseStatement)) return undefined;
  const condition = statement.expression;
  if (!ts.isPropertyAccessExpression(condition.left) || !ts.isIdentifier(condition.left.expression)
    || condition.left.expression.text !== 'process' || condition.left.name.text !== 'platform'
    || condition.left.questionDotToken || !ts.isStringLiteral(condition.right) || condition.right.text !== 'win32'
    || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(condition.operatorToken.kind)) return undefined;
  const yes = statement.thenStatement.statements.map(item => directName(item, aliases));
  const no = statement.elseStatement.statements.map(item => directName(item, aliases));
  if (!yes.length || !no.length || [...yes, ...no].some(name => name === undefined)) return undefined;
  const equal = platform === 'win32';
  return (condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : !equal) ? yes : no;
}

// No-context callers retain top-level-only discovery. No test source is executed.
export function discoverTestIds(path, source, context) {
  if (context !== undefined && (context === null || typeof context !== 'object' || Array.isArray(context)
    || Object.keys(context).length !== 1 || !Object.hasOwn(context, 'platform') || !platforms.has(context.platform))) {
    throw new Error('Invalid literal test platform context');
  }
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`Invalid test source ${path}`);
  const aliases = new Set();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'node:test') continue;
    if (statement.importClause?.name) aliases.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
      if ((item.propertyName ?? item.name).text === 'test') aliases.add(item.name.text);
    }
  }
  const conditional = context !== undefined && conditionalSafe(tree, aliases), names = new Set();
  for (const statement of tree.statements) {
    const direct = directName(statement, aliases);
    const selected = direct !== undefined ? [direct] : conditional ? selectedBranch(statement, context.platform, aliases) ?? [] : [];
    for (const name of selected) {
      if (names.has(name)) throw new Error(`Duplicate declared test ${path}:${name}`);
      names.add(name);
    }
  }
  return names;
}
