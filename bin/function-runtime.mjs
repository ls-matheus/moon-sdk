import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { verifyUser, queryDatabase } from "./database-api.mjs";
import { createClient, createAdapter } from "../dist/index.js";

export function compileFunction(source) {
  if (source.length > 200000) throw new Error("Função excede o limite do executor local.");
  const parsed = ts.createSourceFile("entry.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  if (parsed.parseDiagnostics.length) throw new Error("Função contém erros de sintaxe.");
  let sdkImport;
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const name = node.moduleSpecifier.text;
      if (!/^(?:npm:)?@base44\/sdk(?:@[0-9.]+)?$/.test(name) || sdkImport ||
          !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) ||
          node.importClause.namedBindings.elements.some(item => (item.propertyName || item.name).text !== "createClientFromRequest"))
        throw new Error("Esta função usa dependências ainda não suportadas localmente. Não será enviada ao backend Base44 como fallback.");
      sdkImport = name;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error("Imports dinâmicos não são suportados na função local.");
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!sdkImport) throw new Error("Função sem createClientFromRequest não suportada neste executor.");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return { code, sdkImport };
}

export function runFunctionSource(source, payload, user, invoke, timeout = 90000) {
  const compiled = compileFunction(source);
  return new Promise((resolveResult, reject) => {
    const worker = new Worker(new URL("./function-worker.mjs", import.meta.url), {
      workerData: { ...compiled, payload, user }, env: {}, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let settled = false, requests = 0;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolveResult(result);
    };
    const timer = setTimeout(() => finish(new Error("A função excedeu o tempo limite.")), timeout);
    worker.on("error", () => finish(new Error("Falha no processo da função local.")));
    worker.on("exit", () => { if (!settled) finish(new Error("A função encerrou sem resposta.")); });
    worker.on("message", async message => {
      if (settled) return;
      if (message.type === "result") {
        try { finish(null, { status: message.status, data: JSON.parse(message.body) }); }
        catch { finish(new Error("A função deve retornar JSON.")); }
      } else if (message.type === "failed") finish(new Error(message.error));
      else if (message.type === "rpc") {
        if (++requests > 30) { finish(new Error("Limite de operações da função excedido.")); return; }
        try {
          const result = await invoke(message.method, message.args);
          if (!settled) worker.postMessage({ id: message.id, result });
        } catch (error) { if (!settled) worker.postMessage({ id: message.id, error: error.publicMessage || "Operação da função recusada. Verifique login, configuração de IA e recursos suportados." }); }
      }
    });
  });
}

export async function invokeLocalFunction(name, payload, token, config, env, directory, askAi) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Nome de função inválido.");
  const user = await verifyUser(token, config, env);
  if (!["supabase", "postgres", "mysql"].includes(config.provider)) throw new Error("Funções locais com dados suportam Supabase, PostgreSQL e MySQL nesta versão.");
  const folder = resolve(directory, "base44/functions");
  const entry = ["entry.ts", "entry.js"].map(file => resolve(folder, name, file)).find(existsSync);
  if (!entry || !realpathSync(entry).startsWith(realpathSync(folder) + sep)) throw new Error("Função não encontrada no projeto.");
  const source = readFileSync(entry, "utf8");
  const client = createClient(createAdapter({ provider: config.provider, auth: { getUser: async () => ({ user }) }, execute: request => queryDatabase(request, token, config, env, directory) }));
  let llmCalls = 0;
  return runFunctionSource(source, payload, user, async (method, args) => {
    if (method === "entity") {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(args.entity) || !["list", "filter", "get"].includes(args.method) || !Array.isArray(args.args) || args.args.length > 5) throw new Error("Consulta de função não suportada.");
      return client.entities[args.entity][args.method](...args.args);
    }
    if (method === "llm") {
      if (++llmCalls > 2 || typeof args?.prompt !== "string" || args.prompt.length > 100000 || Object.keys(args).some(key => key !== "prompt")) throw new Error("Parâmetros de IA não suportados.");
      return askAi([{ role: "user", content: args.prompt }]);
    }
    throw new Error("Operação não suportada.");
  });
}
