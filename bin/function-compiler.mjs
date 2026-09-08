import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep, extname } from 'node:path';
import ts from 'typescript';

export function compileFunction(source, entryPath = null, projectDir = null) {
  const modules = Object.create(null), visited = new Map();
  const root = projectDir && realpathSync(projectDir);
  let size = 0;
  function compile(text, file) {
    if (visited.has(file)) return visited.get(file);
    if (visited.size >= 128 || text.length > 200000 || (size += text.length) > 2000000) throw new Error('Função excede o limite de módulos/tamanho.');
    const id = String(visited.size); visited.set(file, id);
    const record = modules[id] = { code: '', dependencies: Object.create(null) };
    const parsed = ts.createSourceFile(file || 'entry.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (parsed.parseDiagnostics.length) throw new Error('Função contém erros de sintaxe.');
    const serveCalls = parsed.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(parsed) === 'Deno.serve');
    if (serveCalls.length > 1) throw new Error('A função deve registrar apenas um handler Deno.serve.');
    if (serveCalls.length && parsed.statements.some(node => ts.isExportAssignment(node) || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))) throw new Error('Use export default ou Deno.serve, não ambos.');
    for (const node of serveCalls) if (node.expression.arguments.length !== 1) throw new Error('Deno.serve local aceita apenas o handler.');
    const dependency = specifier => {
      if (/^(?:npm:)?@base44\/sdk(?:@[0-9.]+)?$/.test(specifier)) return '@sdk';
      if (!specifier.startsWith('.') || !file || !root) throw new Error('Esta função usa dependências ainda não suportadas localmente: ' + specifier);
      const target = resolve(dirname(file), specifier);
      const paths = [target, ...['.ts','.js','.mjs','/index.ts','/index.js'].map(suffix => target + suffix)];
      if (target.endsWith('.js')) paths.push(target.slice(0, -3) + '.ts');
      const found = paths.find(path => existsSync(path) && statSync(path).isFile());
      const real = found && realpathSync(found);
      if (!real || !real.startsWith(root + sep) || real.split(sep).includes('node_modules') || !['.ts','.js','.mjs'].includes(extname(real))) throw new Error('Módulo relativo ausente ou fora do código permitido: ' + specifier);
      return compile(readFileSync(real, 'utf8'), real);
    };
    function visit(node) {
      if (ts.isImportEqualsDeclaration(node)) throw new Error('Import require não suportado. Use import estático.');
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (node.isTypeOnly || node.importClause?.isTypeOnly) return;
        const spec = node.moduleSpecifier.text;
        const dep = dependency(spec);
        if (dep === '@sdk' && (!ts.isImportDeclaration(node) || node.importClause?.name || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) || node.importClause.namedBindings.elements.some(item => !item.isTypeOnly && (item.propertyName || item.name).text !== 'createClientFromRequest'))) throw new Error('Import do SDK não suportado: use createClientFromRequest.');
        record.dependencies[spec] = dep;
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) throw new Error('Imports dinâmicos/require não são suportados na função local.');
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    record.code = ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      transformers: { before: [context => sourceFile => {
        const visit = node => {
          if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.expression.getText(sourceFile) === 'Deno' && node.expression.expression.name.text === 'serve') {
            return context.factory.createExpressionStatement(context.factory.createAssignment(
              context.factory.createPropertyAccessExpression(context.factory.createIdentifier('exports'), 'default'), node.expression.arguments[0]));
          }
          return ts.visitEachChild(node, visit, context);
        };
        return ts.visitNode(sourceFile, visit);
      }] },
    }).outputText;
    return id;
  }
  const entryId = compile(source, entryPath && realpathSync(entryPath));
  return { modules, entryId };
}
