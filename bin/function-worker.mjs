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

const entities = serviceRole => new Proxy({}, { get(_target, entity) {
  if (typeof entity !== "string" || entity === "then") return undefined;
  return Object.fromEntries(["list", "filter", "get", "create", "update", "delete", "bulkCreate", "bulkUpdate"].map(method => [
    method,
    (...args) => rpc("entity", { entity, method, args, ...(serviceRole ? { serviceRole: true } : {}) })
  ]));
} });

const client = {
  entities: entities(false),
  auth: { me: async () => workerData.user },
  integrations: { Core: { InvokeLLM: params => rpc("llm", params) } }
};

client.asServiceRole = { ...client, entities: entities(true) };

const moduleCache = new Map();
function loadModule(name) {
  if (name === '@sdk') {
    return { createClientFromRequest: () => client };
  }
  if (workerData.modules && workerData.modules[name]) {
    if (moduleCache.has(name)) return moduleCache.get(name).exports;
    const subModule = { exports: {} };
    moduleCache.set(name, subModule);
    const record = workerData.modules[name];
    const subContext = vm.createContext({
      exports: subModule.exports, module: subModule,
      require(specifier) {
        if (!Object.hasOwn(record.dependencies, specifier)) throw new Error('Dependência não declarada.');
        return loadModule(record.dependencies[specifier]);
      },
      Request, Response, Headers, FormData, File, Blob, URL, URLSearchParams, TextEncoder, TextDecoder,
    }, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(record.code, { filename: 'function-module-' + name }).runInContext(subContext, { timeout: 2000 });
    return subModule.exports;
  }
  throw new Error("Dependência de função não suportada pelo executor local: " + name);
}

try {
  const entry = loadModule(workerData.entryId);
  if (typeof entry.default !== "function") throw new Error("Função deve exportar um handler default.");
  const http = workerData.httpRequest;
  const request = http ? new Request(http.url, { method: http.method, headers: http.headers, ...(!['GET', 'HEAD'].includes(http.method) ? { body: new Uint8Array(http.body) } : {}) })
    : new Request("http://localhost/function", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(workerData.payload) });
  const response = await entry.default(request);
  if (!(response instanceof Response)) throw new Error("A função não retornou uma Response.");
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1048576) throw new Error("Resposta da função excedeu o limite.");
    chunks.push(chunk);
  }
  parentPort.postMessage({ type: "result", status: response.status, headers: [...response.headers], body: Buffer.concat(chunks) });
} catch (err) {
  parentPort.postMessage({ type: "failed", error: err?.message || "Não foi possível executar a função local. Verifique a configuração de IA e os recursos suportados." });
}
