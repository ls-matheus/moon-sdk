import ts from 'typescript';
import { relative } from 'node:path';
import { featureStatus } from './compatibility-catalog.mjs';

// Resolve imported clients, renamed bindings and destructured methods without executing code.
export function inspectSdkCalls(directory, files) {
  const program = ts.createProgram(files, { allowJs: true, checkJs: false, noEmit: true, noResolve: false, skipLibCheck: true, baseUrl: directory, paths: { '@/*': ['src/*'] }, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext });
  const checker = program.getTypeChecker(), calls = [], diagnostics = [];
  function origin(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) return origin(node.expression, seen);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parent = origin(node.expression, seen);
      if (!parent) return null;
      const name = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '?';
      return parent + '.' + name;
    }
    if (ts.isCallExpression(node)) {
      const factory = origin(node.expression, seen);
      return factory === '$factory' || factory === '$sdkModule.createClient' || factory === '$sdkModule.createClientFromRequest' ? '$sdk' : null;
    }
    if (!ts.isIdentifier(node)) return null;
    let symbol = checker.getSymbolAtLocation(node);
    for (const declaration of symbol?.declarations || []) {
      if (ts.isImportSpecifier(declaration) || ts.isNamespaceImport(declaration)) {
        const imported = ts.isImportSpecifier(declaration) ? (declaration.propertyName || declaration.name).text : '*';
        let parent = declaration;
        while (parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
        const module = parent?.moduleSpecifier?.text || '';
        if (/^(?:npm:)?@base44\/sdk(?:@[\d.]+)?$/.test(module)) {
          if (imported === '*') return '$sdkModule';
          if (['createClient', 'createClientFromRequest'].includes(imported)) return '$factory';
        }
        if (/base44Client(?:\.[jt]s)?$/.test(module) && imported === 'base44') return '$sdk';
      }
    }
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol?.declarations || []) {
      if (ts.isVariableDeclaration(declaration)) { const value = origin(declaration.initializer, seen); if (value) return value; }
      if (ts.isBindingElement(declaration)) {
        const parent = declaration.parent.parent;
        const base = ts.isVariableDeclaration(parent) ? origin(parent.initializer, seen) : ts.isBindingElement(parent) ? origin(parent.name, seen) : null;
        if (base) return base + '.' + (declaration.propertyName || declaration.name).getText().replace(/^['"]|['"]$/g, '');
      }
    }
    return !symbol && node.text === 'base44' ? '$sdk' : null;
  }
  for (const file of files) {
    const parsed = program.getSourceFile(file);
    if (!parsed) continue;
    const label = relative(directory, file).replaceAll('\\', '/');
    const backend = /^(?:base44\/)?functions\//.test(label);
    const location = node => ({ file: label, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1 });
    for (const error of parsed.parseDiagnostics) diagnostics.push({ ...location({ getStart: () => error.start || 0 }), message: ts.flattenDiagnosticMessageText(error.messageText, '\n') });
    function visit(node) {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const module = node.moduleSpecifier.text;
        if (/^@base44\/sdk\//.test(module) && !/^@base44\/sdk\/dist\/utils\/axios-client(?:\.js)?$/.test(module)) diagnostics.push({ ...location(node), severity: 'error', message: 'Import interno do SDK sem adaptação: ' + module });
        if (module === '@base44/sdk' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const item of node.importClause.namedBindings.elements) if (!item.isTypeOnly && !['createClient', 'Base44Error', ...(backend ? ['createClientFromRequest'] : [])].includes((item.propertyName || item.name).text)) diagnostics.push({ ...location(item), severity: 'error', message: 'Export do SDK exige adaptação neste contexto: ' + (item.propertyName || item.name).text });
        }
      }
      if (ts.isCallExpression(node)) {
        const path = origin(node.expression);
        if (path?.startsWith('$sdk.')) {
          const feature = path.slice(5);
          calls.push({ ...location(node), path: feature, ...featureStatus(feature, backend), dynamic: feature.includes('?'), backend });
          if (/^(?:asServiceRole\.)?entities\.[^.]+\.filter$/.test(feature) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
            const check = value => {
              if (ts.isPropertyAssignment(value)) {
                const key = value.name.getText(parsed).replace(/^['"]|['"]$/g, '');
                if (key.startsWith('$') && !['$eq', '$ne', '$neq', '$gt', '$gte', '$lt', '$lte', '$in', '$is', '$ilike', '$contains'].includes(key)) diagnostics.push({ ...location(value), message: 'Operador sem tradução geral: ' + key });
              }
              ts.forEachChild(value, check);
            };
            check(node.arguments[0]);
          }
        }
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && !ts.isStringLiteralLike(node.arguments[0])) diagnostics.push({ ...location(node), message: 'Import dinâmico calculado exige revisão manual.' });
      }
      if (ts.isStringLiteralLike(node) && /https?:\/\/[^/]*(?:base44\.app|base44\.com)(?:\/|$)/i.test(node.text)) diagnostics.push({ ...location(node), message: 'Referência a serviço hospedado Base44: revisar/remover para execução independente.' });
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  return { calls, diagnostics };
}
