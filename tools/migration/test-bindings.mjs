import ts from 'typescript';

// Recognize direct, nonempty, literal node:test declarations without running tests.
// Dynamic loops/names and alternate runners need a separate reviewed adapter.
export function discoverTestIds(path, source) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`Invalid test source ${path}`);
  const aliases = new Set();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'node:test') continue;
    if (statement.importClause?.name) aliases.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if ((item.propertyName ?? item.name).text === 'test') aliases.add(item.name.text);
      }
    }
  }
  const names = new Set();
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || !aliases.has(call.expression.text)) continue;
    const [name, callback] = call.arguments;
    // Options can suppress execution; accept the simple two-argument form only.
    if (call.arguments.length !== 2 || !name || !ts.isStringLiteral(name) || !callback
      || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) continue;
    if (ts.isBlock(callback.body) && !callback.body.statements.length) continue;
    if (names.has(name.text)) throw new Error(`Duplicate declared test ${path}:${name.text}`);
    names.add(name.text);
  }
  return names;
}
