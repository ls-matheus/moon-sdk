import { readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import ts from "typescript";
import { normalizeSchema } from "./database-schema.mjs";

// Static analysis only: application code is never imported or executed.
export function inferApplicationSchema(directory) {
  const files = [];
  const ignored = new Set(["node_modules", ".git", ".moon", "dist", "build", ".next", "coverage", "moon", "tests", "__tests__"]);
  function walk(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:[cm]?js|jsx|tsx?)$/.test(entry.name) && !/\.(?:d\.ts|test\.[^.]+|spec\.[^.]+)$/.test(entry.name)) files.push(path);
    }
  }
  walk(directory);
  const configPath = ts.findConfigFile(directory, ts.sys.fileExists, "tsconfig.json") || ts.findConfigFile(directory, ts.sys.fileExists, "jsconfig.json");
  let projectOptions = {};
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(`Não foi possível ler a configuração do aplicativo: ${configPath}`);
    projectOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, "..")).options;
  }
  const program = ts.createProgram(files.sort(), {
    ...projectOptions,
    allowJs: true, checkJs: true, noEmit: true, strictNullChecks: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const entities = Object.create(null);
  const problems = new Set();
  const origins = [];
  function problem(node, message) {
    const source = node.getSourceFile();
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    problems.add(`${relative(directory, source.fileName)}:${line + 1}: ${message}`);
  }
  function scalar(type, seen = new Set()) {
    if (seen.has(type)) return undefined;
    const next = new Set(seen).add(type);
    if (type.isUnion()) {
      const members = type.types.filter(t => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
      const kinds = new Set(members.map(member => scalar(member, next)));
      return kinds.size === 1 ? [...kinds][0] : undefined;
    }
    if (type.flags & ts.TypeFlags.StringLike) return "string";
    if (type.flags & ts.TypeFlags.NumberLike) return "number";
    if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter)) return undefined;
    if (checker.isArrayType(type) || checker.isTupleType(type)) return "json";
    // Do not silently serialize Date, functions, or arbitrary class instances.
    if (type.flags & ts.TypeFlags.Object && !type.getCallSignatures().length &&
        (!type.symbol || ["__object", "__type"].includes(type.symbol.name) || type.symbol.flags & ts.SymbolFlags.Interface)) {
      for (const property of type.getProperties()) {
        const declaration = property.valueDeclaration || property.declarations?.[0];
        if (!declaration) return undefined;
        const member = checker.getTypeOfSymbolAtLocation(property, declaration);
        if (!(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) && !scalar(member, next)) return undefined;
      }
      return "json";
    }
    return undefined;
  }
  function payload(entity, node) {
    if (!node) return;
    const type = checker.getTypeAtLocation(node);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || type.isUnion() || checker.isArrayType(type) ||
        checker.getIndexTypeOfType(type, ts.IndexKind.String) || !type.getProperties().length) {
      problem(node, `${entity}: não foi possível determinar os campos enviados pela aplicação.`);
      return;
    }
    for (const property of type.getProperties()) {
      const name = property.name;
      if (["id", "created_at", "updated_at", "user_id"].includes(name)) continue;
      const fieldType = scalar(checker.getTypeOfSymbolAtLocation(property, node));
      if (!fieldType) { problem(node, `${entity}.${name}: tipo dinâmico ou incompatível com o esquema portátil.`); continue; }
      const previous = entities[entity].fields[name];
      if (previous && previous.type !== fieldType) { problem(node, `${entity}.${name}: tipos incompatíveis entre gravações.`); continue; }
      // Observed payloads do not prove a field is required in every workflow.
      entities[entity].fields[name] = { type: fieldType, required: false };
    }
  }
  for (const file of files) {
    const source = program.getSourceFile(file);
    function visit(node) {
      if (ts.isElementAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "entities")
        problem(node, "Acesso por entities[...] precisa de uma definição exportada para análise segura.");
      if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "entities") {
        const entity = node.name.text;
        entities[entity] ||= { access: "owner", fields: Object.create(null) };
        if (source.parseDiagnostics.length) problem(node, "O código contém erros de sintaxe; a análise não é segura.");
        const method = node.parent;
        const call = method?.parent;
        if (!ts.isPropertyAccessExpression(method) || !ts.isCallExpression(call) || call.expression !== method)
          problem(node, `${entity}: referência indireta à entidade precisa de uma definição exportada.`);
        if (ts.isPropertyAccessExpression(method) && ts.isCallExpression(call) && call.expression === method) {
          if (["create", "update"].includes(method.name.text)) {
            const data = call.arguments[method.name.text === "update" ? 1 : 0];
            if (data) payload(entity, data); else problem(call, `${entity}: gravação sem dados identificáveis.`);
          } else if (method.name.text === "bulkCreate") {
            const data = call.arguments[0];
            if (data && ts.isArrayLiteralExpression(data)) for (const item of data.elements) payload(entity, item);
            else problem(call, `${entity}: lista de gravação dinâmica não reconhecida.`);
          }
        }
        origins.push(relative(directory, file));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  for (const [entity, def] of Object.entries(entities)) if (!Object.keys(def.fields).length)
    problems.add(`${entity}: há uso da entidade, mas nenhuma estrutura de gravação reconhecível.`);
  if (problems.size) throw new Error("A estrutura não pôde ser identificada com segurança. O código/exportação precisa de revisão técnica; não é necessário preencher tabelas manualmente. Nenhum banco foi alterado.\n" + [...problems].join("\n"));
  if (!Object.keys(entities).length) throw new Error("Não encontrei definições de dados nem gravações entities.Nome.create/update no código deste aplicativo. Abra a pasta com o código completo ou inclua as definições exportadas da plataforma. Nenhum banco foi alterado.");
  return { schema: normalizeSchema({ version: 1, entities }), source: "código da aplicação", files: [...new Set(origins)].sort() };
}
