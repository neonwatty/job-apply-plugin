import ts from 'typescript';
import { posix } from 'node:path';

// Parse only. Browser initialization, network requests and imports never execute.
export function discoverBrowserExports(files) {
  const cache = new Map();
  const visiting = new Set();
  function exportsOf(path) {
    if (cache.has(path)) return cache.get(path);
    if (visiting.has(path)) throw new Error(`Cyclic browser re-export requires review: ${path}`);
    if (!files.has(path)) throw new Error(`Missing browser export source: ${path}`);
    visiting.add(path);
    const tree = ts.createSourceFile(path, files.get(path), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    if (tree.parseDiagnostics.length) throw new Error(`Invalid browser JavaScript: ${path}`);
    const explicit = new Map();
    const stars = [];
    const add = (name, sources) => {
      if (explicit.has(name)) throw new Error(`Duplicate explicit browser export: ${path}:${name}`);
      explicit.set(name, [...new Set([path, ...sources])]);
    };
    for (const statement of tree.statements) {
      if (ts.isExportAssignment(statement)) { add('default', []); continue; }
      if (ts.isExportDeclaration(statement)) {
        let target;
        if (statement.moduleSpecifier) {
          if (!ts.isStringLiteral(statement.moduleSpecifier)
            || !statement.moduleSpecifier.text.startsWith('.')) throw new Error(`Unsupported browser re-export: ${path}`);
          target = posix.normalize(posix.join(posix.dirname(path), statement.moduleSpecifier.text));
          if (!target.startsWith('workspace/')) throw new Error(`Browser re-export escapes workspace: ${path}`);
        }
        if (!statement.exportClause) {
          if (!target) throw new Error(`Missing export-star target: ${path}`);
          stars.push(exportsOf(target));
        } else if (ts.isNamespaceExport(statement.exportClause)) {
          if (!target) throw new Error(`Missing namespace export target: ${path}`);
          exportsOf(target);
          add(statement.exportClause.name.text, [target]);
        } else {
          if (!target) throw new Error(`Local browser export list requires binding review: ${path}`);
          for (const item of statement.exportClause.elements) {
            const original = (item.propertyName ?? item.name).text;
            const bindings = target ? exportsOf(target).get(original) : [];
            if (!bindings) throw new Error(`Unknown re-export ${path}:${original}`);
            add(item.name.text, bindings);
          }
        }
        continue;
      }
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (statement.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        add('default', []); continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) throw new Error(`Destructured browser export requires review: ${path}`);
          add(declaration.name.text, []);
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        add(statement.name.text, []);
      } else throw new Error(`Unsupported browser export declaration: ${path}`);
    }
    const result = new Map(explicit);
    for (const star of stars) {
      for (const [name, bindings] of star) {
        if (name === 'default' || explicit.has(name)) continue;
        const prior = result.get(name);
        // Repeated star bindings require review, even when terminal files agree:
        // distinct names in that file may have been reexported under one alias.
        if (prior) throw new Error(`Ambiguous browser export requires review: ${path}:${name}`);
        result.set(name, [...new Set([path, ...bindings])]);
      }
    }
    visiting.delete(path);
    cache.set(path, result);
    return result;
  }
  const result = [];
  for (const path of [...files.keys()].sort()) {
    for (const [name, sources] of exportsOf(path)) result.push({ path, name, sources });
  }
  return result;
}

export function checkBrowserBindings(discovered, surfaces) {
  const errors = [];
  const remaining = new Map(surfaces.filter((surface) => surface.kind === 'browser')
    .map((surface) => [`${surface.sources[0]}:${surface.export}`, surface]));
  for (const item of discovered) {
    const key = `${item.path}:${item.name}`;
    const surface = remaining.get(key);
    if (!surface) errors.push(`Uninventoried browser export ${key}`);
    else if (item.sources.some((source) => !surface.sources.includes(source))) errors.push(`Missing browser binding source ${key}`);
    remaining.delete(key);
  }
  for (const key of remaining.keys()) errors.push(`Obsolete browser export ${key}`);
  return errors;
}
