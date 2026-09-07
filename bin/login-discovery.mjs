import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import ts from 'typescript';

export function localLoginPath(value) {
  if (typeof value !== 'string' || !/^\/(?!\/)[A-Za-z0-9_/-]*$/.test(value) || value.split('/').includes('..')) {
    throw new Error('authUi.loginPath deve ser uma rota local, por exemplo /login.');
  }
  return value;
}

// Follow the entry's imports, not every file: an unused Login.jsx is not a login screen.
export function discoverLoginUi(directory, entry, options = {}) {
  const mode = options.mode || 'auto';
  if (!['auto', 'app', 'moon'].includes(mode)) throw new Error('authUi.mode deve ser auto, app ou moon.');
  const explicitPath = options.loginPath == null ? null : localLoginPath(options.loginPath);
  if (mode === 'moon') return { mode: 'moon', loginPath: null };
  const root = resolve(directory, 'src');
  const pending = [resolve(directory, entry.replace(/^\//, ''))], seen = new Set();
  let hasLogin = false;
  const routes = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file) || !file.startsWith(root + sep) || !existsSync(file)) continue;
    seen.add(file);
    if (seen.size > 1500) throw new Error('Análise de login excedeu o limite de arquivos.');
    const parsed = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const enqueue = specifier => {
      if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return;
      const target = specifier.startsWith('@/') ? resolve(root, specifier.slice(2)) : resolve(dirname(file), specifier);
      const candidate = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx']
        .map(extension => target + extension).find(path => existsSync(path) && statSync(path).isFile());
      if (candidate) pending.push(candidate);
    };
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) enqueue(node.moduleSpecifier.text);
      if (ts.isCallExpression(node)) {
        if (!/[\\/]base44Client\.[jt]s$/.test(file) && ts.isPropertyAccessExpression(node.expression) &&
            ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'auth' &&
            ['loginViaEmailPassword', 'loginWithProvider'].includes(node.expression.name.text)) hasLogin = true;
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) enqueue(node.arguments[0].text);
      }
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(parsed) === 'Route') {
        const attr = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.text === 'path');
        const value = attr?.initializer;
        const path = value && ts.isStringLiteral(value) ? value.text : value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteral(value.expression) ? value.expression.text : null;
        if (path && /^\/(login|sign-?in|entrar)\/?$/i.test(path)) routes.add(path);
      }
      // Base44's generated router maps PAGES keys directly to /PageName.
      if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'PAGES' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          const name = property.name && (ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(parsed));
          if (name && /^(login|sign-?in|entrar)$/i.test(name)) routes.add('/' + name);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(parsed);
  }
  return { mode: mode === 'app' || hasLogin ? 'app' : 'moon', loginPath: explicitPath || (routes.size === 1 ? [...routes][0] : null) };
}
