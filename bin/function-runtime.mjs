import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { compileFunction } from "./function-compiler.mjs";
export { compileFunction } from "./function-compiler.mjs";
import { invokeLLM } from "./structured-ai.mjs";
import { verifyUser, queryDatabase } from "./database-api.mjs";
import { createClient, createAdapter } from "../dist/index.js";

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
        } catch (error) { if (!settled) worker.postMessage({ id: message.id, error: error.publicMessage || error.message || "Operação da função recusada. Verifique login, configuração de IA e recursos suportados." }); }
      }
    });
  });
}

export async function invokeLocalFunction(name, payload, token, config, env, directory, askAi) {
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(name)) throw new Error("Nome de função inválido.");
  const policy = config.localFunctions?.[name] || {};
  if (policy.access && !['public', 'authenticated'].includes(policy.access)) throw new Error('Permissão de função inválida.');
  const user = token ? await verifyUser(token, config, env) : null;
  if (!user && policy.access !== 'public') {
    const error = new Error('Entre na sua conta para usar esta função.'); error.status = 401; error.publicMessage = error.message; throw error;
  }
  if (!["supabase", "postgres", "mysql"].includes(config.provider)) throw new Error("Funções locais com dados suportam Supabase, PostgreSQL e MySQL nesta versão.");
  const folder = resolve(directory, "base44/functions");
  const entry = ["entry.ts", "entry.js"].map(file => resolve(folder, name, file)).find(existsSync);
  if (!entry || !realpathSync(entry).startsWith(realpathSync(folder) + sep)) throw new Error("Função não encontrada no projeto.");
  const source = readFileSync(entry, "utf8");
  const makeClient = functionGrants => createClient(createAdapter({
    provider: config.provider,
    auth: { getUser: async () => ({ user }) },
    execute: request => queryDatabase(request, token, config, env, directory, { functionGrants })
  }));
  const client = makeClient(undefined), serviceClient = makeClient(policy.entities);
  let llmCalls = 0;
  return runFunctionSource(source, payload, user, async (method, args) => {
    if (method === "entity") {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(args.entity) || !["list", "filter", "get", "create", "update", "delete", "bulkCreate", "bulkUpdate"].includes(args.method) || !Array.isArray(args.args) || args.args.length > 5) throw new Error("Consulta de função não suportada.");
      try { return await (args.serviceRole ? serviceClient : client).entities[args.entity][args.method](...args.args); }
      catch (error) { error.publicMessage = 'Operação de dados recusada. Confira login, campos e permissões desta função.'; throw error; }
    }
    if (method === "llm") {
      if (!user && policy.allowAI !== true) throw new Error('IA pública precisa de allowAI na configuração desta função.');
      if (++llmCalls > 5 || typeof args?.prompt !== "string" || args.prompt.length > 100000) throw new Error("Parâmetros de IA não suportados.");
      return invokeLLM(args, askAi);
    }
    throw new Error("Operação não suportada.");
  }, 90000, entry, directory);
}
