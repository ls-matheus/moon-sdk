import { existsSync, readFileSync, realpathSync } from "node:fs";
import { existsSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { verifyUser, queryDatabase } from "./database-api.mjs";
import { createClient, createAdapter } from "../dist/index.js";

export function compileFunction(source) {
export function compileFunction(source, entryPath = null, projectDir = null) {
  if (source.length > 200000) throw new Error("Função excede o limite do executor local.");
  const parsed = ts.createSourceFile("entry.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  if (parsed.parseDiagnostics.length) throw new Error("Função contém erros de sintaxe.");
  let sdkImport;
  let sdkImport = "";
  const relativeImports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const name = node.moduleSpecifier.text;
      if (!/^(?:npm:)?@base44\/sdk(?:@[0-9.]+)?$/.test(name) || sdkImport ||
          !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings) ||
          node.importClause.namedBindings.elements.some(item => (item.propertyName || item.name).text !== "createClientFromRequest"))
        throw new Error("Esta função usa dependências ainda não suportadas localmente. Não será enviada ao backend Base44 como fallback.");
      sdkImport = name;
      if (/^(?:npm:)?@base44\/sdk(?:@[0-9.]+)?$/.test(name)) {
        if (sdkImport && sdkImport !== name) throw new Error("Imports múltiplos do SDK Base44 não suportados.");
        sdkImport = name;
      } else if (name.startsWith(".")) {
        relativeImports.push(name);
      } else {
        throw new Error("Esta função usa dependências externas ainda não suportadas localmente: " + name);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw new Error("Imports dinâmicos não são suportados na função local.");
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (!sdkImport) throw new Error("Função sem createClientFromRequest não suportada neste executor.");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return { code, sdkImport };

  const modules = {};
  if (entryPath && projectDir && relativeImports.length) {
    const entryDir = resolve(entryPath, "..");
    const realProject = realpathSync(projectDir);
    const queue = relativeImports.map(spec => ({ spec, fromDir: entryDir }));
    const visited = new Set();
    while (queue.length > 0) {
      const { spec, fromDir } = queue.shift();
      if (visited.has(spec)) continue;
      visited.add(spec);
      let targetPath = resolve(fromDir, spec);
      const candidates = [targetPath, targetPath + ".ts", targetPath + ".js", targetPath + ".mjs", resolve(targetPath, "index.ts"), resolve(targetPath, "index.js")];
      const found = candidates.find(p => existsSync(p) && !lstatSync(p).isDirectory());
      if (!found || !realpathSync(found).startsWith(realProject + sep)) {
        throw new Error("Módulo relativo não encontrado ou fora do projeto: " + spec);
      }
      const modSource = readFileSync(found, "utf8");
      const modCode = ts.transpileModule(modSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
      modules[spec] = modCode;
      const parsedMod = ts.createSourceFile("sub.ts", modSource, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
      const modDir = resolve(found, "..");
      function visitSub(node) {
        if (ts.isImportDeclaration(node)) {
          const subName = node.moduleSpecifier.text;
          if (subName.startsWith(".")) queue.push({ spec: subName, fromDir: modDir });
        }
        ts.forEachChild(node, visitSub);
      }
      visitSub(parsedMod);
    }
  }

  return { code, sdkImport, modules };
}

export function runFunctionSource(source, payload, user, invoke, timeout = 90000) {
  const compiled = compileFunction(source);
export function runFunctionSource(source, payload, user, invoke, timeout = 90000, entryPath = null, projectDir = null) {
  const compiled = compileFunction(source, entryPath, projectDir);
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
        } catch (error) { if (!settled) worker.postMessage({ id: message.id, error: error.publicMessage || error.message || "Operação da função recusada. Verifique login, configuração de IA e recursos suportados." }); }
      }
    });
  });
}

export async function invokeLocalFunction(name, payload, token, config, env, directory, askAi) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Nome de função inválido.");
  const user = await verifyUser(token, config, env);
  let user = null;
  if (token) {
    try { user = await verifyUser(token, config, env); }
    catch { user = null; }
  }
  if (!["supabase", "postgres", "mysql"].includes(config.provider)) throw new Error("Funções locais com dados suportam Supabase, PostgreSQL e MySQL nesta versão.");
  const folder = resolve(directory, "base44/functions");
  const entry = ["entry.ts", "entry.js"].map(file => resolve(folder, name, file)).find(existsSync);
  if (!entry || !realpathSync(entry).startsWith(realpathSync(folder) + sep)) throw new Error("Função não encontrada no projeto.");
  const source = readFileSync(entry, "utf8");
  const client = createClient(createAdapter({ provider: config.provider, auth: { getUser: async () => ({ user }) }, execute: request => queryDatabase(request, token, config, env, directory) }));
  const client = createClient(createAdapter({
    provider: config.provider,
    auth: { getUser: async () => ({ user }) },
    execute: request => queryDatabase(request, token, config, env, directory, { asServiceRole: true, user })
  }));
  let llmCalls = 0;
  return runFunctionSource(source, payload, user, async (method, args) => {
    if (method === "entity") {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(args.entity) || !["list", "filter", "get"].includes(args.method) || !Array.isArray(args.args) || args.args.length > 5) throw new Error("Consulta de função não suportada.");
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(args.entity) || !["list", "filter", "get", "create", "update", "delete"].includes(args.method) || !Array.isArray(args.args) || args.args.length > 5) throw new Error("Consulta de função não suportada.");
      return client.entities[args.entity][args.method](...args.args);
    }
    if (method === "llm") {
      if (++llmCalls > 2 || typeof args?.prompt !== "string" || args.prompt.length > 100000 || Object.keys(args).some(key => key !== "prompt")) throw new Error("Parâmetros de IA não suportados.");
      return askAi([{ role: "user", content: args.prompt }]);
      if (++llmCalls > 5 || typeof args?.prompt !== "string" || args.prompt.length > 100000) throw new Error("Parâmetros de IA não suportados.");
      let promptText = args.prompt;
      if (args.response_json_schema) {
        promptText += "\n\nO JSON gerado DEVE seguir rigorosamente este JSON Schema:\n" + JSON.stringify(args.response_json_schema) + "\n\nRetorne EXCLUSIVAMENTE o JSON estruturado correspondente ao schema solicitado, sem blocos de código markdown (sem ```) e sem texto extra.";
      }
      const raw = (await askAi([{ role: "user", content: promptText }])) || "";
      if (args.response_json_schema) {
        const cleaned = String(raw).replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
        let parsed = null;
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const match = cleaned.match(/\{[\s\S]*\}/);
          if (match) {
            try { parsed = JSON.parse(match[0]); } catch {}
          }
        }
        if (parsed && typeof parsed === "object") {
          if (!parsed.items && Array.isArray(parsed.itens)) parsed.items = parsed.itens;
          if (Array.isArray(parsed.items)) {
            parsed.items = parsed.items.map(item => ({
              name: item.name || item.nome || item.produto || item.sabor || "",
              quantity: Number(item.quantity ?? item.quantidade ?? item.qtd) || 1,
              price: Number(item.price ?? item.preco ?? item.preco_unitario) || 0,
            }));
          }
          return parsed;
        }
        return {};
      }
      return raw;
    }
    throw new Error("Operação não suportada.");
  });
  }, 90000, entry, directory);
}
