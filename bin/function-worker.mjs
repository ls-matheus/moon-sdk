import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const waiting = new Map();
let sequence = 0;
const rpc = (method, args) => new Promise((resolve, reject) => {
  const id = ++sequence;
  waiting.set(id, { resolve, reject }); parentPort.postMessage({ type: "rpc", id, method, args });
});
parentPort.on("message", message => {
  const item = waiting.get(message.id);
  if (!item) return;
  waiting.delete(message.id);
  if (message.error) item.reject(new Error(message.error)); else item.resolve(message.result);
});

const entities = new Proxy({}, { get(_target, entity) {
  if (typeof entity !== "string" || entity === "then") return undefined;
  return Object.fromEntries(["list", "filter", "get"].map(method => [method, (...args) => rpc("entity", { entity, method, args })]));
  return Object.fromEntries(["list", "filter", "get", "create", "update", "delete"].map(method => [
    method,
    (...args) => rpc("entity", { entity, method, args })
  ]));
} });
const client = { entities, auth: { me: async () => workerData.user }, integrations: { Core: { InvokeLLM: params => rpc("llm", params) } } };
// Compatibility never grants administrator access. Parent validates every query as this user.

const client = {
  entities,
  auth: { me: async () => workerData.user },
  integrations: { Core: { InvokeLLM: params => rpc("llm", params) } }
};

client.asServiceRole = client;

const moduleCache = new Map();
function loadModule(name) {
  if (name === workerData.sdkImport || /^(?:npm:)?@base44\/sdk(?:@[0-9.]+)?$/.test(name)) {
    return { createClientFromRequest: () => client };
  }
  if (workerData.modules && workerData.modules[name]) {
    if (moduleCache.has(name)) return moduleCache.get(name);
    const subModule = { exports: {} };
    const subContext = vm.createContext({
      exports: subModule.exports, module: subModule,
      require: loadModule,
      Request, Response, URL, TextEncoder, TextDecoder, console,
    }, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(workerData.modules[name], { filename: name }).runInContext(subContext, { timeout: 2000 });
    moduleCache.set(name, subModule.exports);
    return subModule.exports;
  }
  throw new Error("Dependência de função não suportada pelo executor local: " + name);
}

const module = { exports: {} };
const context = vm.createContext({
  exports: module.exports, module, Request, Response, URL, TextEncoder, TextDecoder,
  require(name) { if (name !== workerData.sdkImport) throw new Error("Dependência de função não suportada pelo executor local."); return { createClientFromRequest: () => client }; },
  exports: module.exports, module, Request, Response, URL, TextEncoder, TextDecoder, console,
  require: loadModule,
}, { codeGeneration: { strings: false, wasm: false } });

try {
  new vm.Script(workerData.code, { filename: "imported-function.js" }).runInContext(context, { timeout: 1000 });
  new vm.Script(workerData.code, { filename: "imported-function.js" }).runInContext(context, { timeout: 2000 });
  if (typeof module.exports.default !== "function") throw new Error("Função deve exportar um handler default.");
  const response = await module.exports.default(new Request("http://localhost/function", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(workerData.payload) }));
  if (!(response instanceof Response)) throw new Error("A função não retornou uma Response.");
  const body = await response.text();
  if (body.length > 1048576) throw new Error("Resposta da função excedeu o limite.");
  parentPort.postMessage({ type: "result", status: response.status, body });
} catch { parentPort.postMessage({ type: "failed", error: "Não foi possível executar a função local. Verifique a configuração de IA e os recursos suportados." }); }
} catch (err) {
  parentPort.postMessage({ type: "failed", error: err?.message || "Não foi possível executar a função local. Verifique a configuração de IA e os recursos suportados." });
}
