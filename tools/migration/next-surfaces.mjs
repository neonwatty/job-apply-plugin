import ts from 'typescript';

// Parse declarations only: never import or execute application code.
export const isNextComponentSource = path =>
  /^apps\/companion\/components\/[^/]+\.tsx?$/.test(path);

export function discoverNextBrowserExports(files) {
  const result = [];
  for (const path of [...files.keys()].sort()) {
    if (!isNextComponentSource(path)) throw new Error(`Unexpected Next component source: ${path}`);
    const tree = ts.createSourceFile(path, files.get(path), ts.ScriptTarget.Latest, true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (tree.parseDiagnostics.length) throw new Error(`Invalid Next component source: ${path}`);
    const names = new Set();
    function add(name) {
      if (names.has(name)) throw new Error(`Duplicate Next runtime export: ${path}:${name}`);
      names.add(name);
      result.push({ path, name, sources: [path] });
    }
    for (const statement of tree.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        throw new Error(`Next re-export requires review: ${path}`);
      }
      if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) throw new Error(`Next export assignment requires review: ${path}`);
        add('default');
        continue;
      }
      const modifiers = statement.modifiers ?? [];
      if (!modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;
      if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword))
        throw new Error(`Ambient Next export requires review: ${path}`);
      if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        if ((!ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement))
            || ts.isFunctionDeclaration(statement) && !statement.body)
          throw new Error(`Unsupported Next default declaration: ${path}`);
        add('default');
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        if (!statement.name || ts.isFunctionDeclaration(statement) && !statement.body)
          throw new Error(`Incomplete Next runtime declaration: ${path}`);
        add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
            throw new Error(`Unsupported Next variable export: ${path}`);
          add(declaration.name.text);
        }
      } else throw new Error(`Unsupported Next runtime export: ${path}`);
    }
  }
  return result;
}
