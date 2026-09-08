#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { queryDatabase, verifyUser } from "./database-api.mjs";
import { invokeLocalFunction } from "./function-runtime.mjs";
import { isAllowedOrigin } from './http-security.mjs';

const port = Number(process.env.MOON_BACKEND_PORT || 8787);
const projectDir = process.cwd();
const configPath = resolve(projectDir, "moon.config.json");

function loadConfig() {
  if (!existsSync(configPath)) return {};
  try { return JSON.parse(readFileSync(configPath, "utf8")); } catch { return {}; }
}

async function askAi(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 100 || messages.some(message => !["user", "assistant", "system"].includes(message.role) || typeof message.content !== "string" || message.content.length > 100000)) throw new Error("Mensagens de IA inválidas.");
  const provider = (process.env.MOON_AI_PROVIDER || "openai").toLowerCase();
  const key = process.env.MOON_AI_API_KEY;
  if (!key) throw new Error("API de IA não configurada");
  const model = process.env.MOON_AI_MODEL || (provider === "gemini" ? "gemini-2.0-flash" : "gpt-4o-mini");
  const base = process.env.MOON_AI_BASE_URL || (provider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1");
  let url = `${base.replace(/\/$/, "")}/chat/completions`;
  let headers = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  let body = { model, messages };
  if (provider === "anthropic") {
    url = `${base.replace(/\/$/, "")}/messages`;
    headers = { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
    body = { model, max_tokens: 1024, messages: messages.filter((message) => message.role !== "system") };
  }
  if (provider === "gemini") {
    url = `${base.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
    headers = { "Content-Type": "application/json", "x-goog-api-key": key };
    body = { contents: messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })) };
  }
  let result;
  try {
    result = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  } catch (error) {
    error.publicMessage = error.name === "TimeoutError" ? "O provedor de IA demorou mais de 60 segundos. Tente novamente." : "Não foi possível conectar ao provedor de IA. Confira sua conexão.";
    throw error;
  }
  const data = await result.json();
  if (!result.ok) {
    const error = new Error(`IA respondeu HTTP ${result.status}`);
    error.publicMessage = result.status === 429 ? "A IA atingiu o limite de uso/cota. Confira a conta do provedor." : result.status === 404 ? "O modelo de IA configurado não está disponível para esta API/conta." : [401,403].includes(result.status) ? "A chave de IA foi recusada. Confira a chave e suas permissões." : "O provedor de IA recusou a solicitação. Confira a configuração.";
    throw error;
  }
  const content = provider === "anthropic"
    ? data.content?.[0]?.text
    : provider === "gemini"
    ? (data.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text || "").join("") || "")
    : data.choices?.[0]?.message?.content || "";
  if (!content) throw new Error("A IA não retornou conteúdo");
  return content;
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  const origin = request.headers.origin || "";
  if (!isAllowedOrigin(origin, { port: process.env.MOON_FRONTEND_PORT || 5173, network: process.env.MOON_NETWORK === 'true' })) { response.statusCode = 403; response.end(JSON.stringify({error:"Origem não permitida. Use o endereço exibido pelo Moon; para rede local, inicie com --network."})); return; }
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
  if (request.method === "POST" && request.url === "/api/database") {
    let raw = "", size = 0, oversized = false;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > 1048576) { oversized = true; return; }
      raw += chunk;
    });
    request.on("end", async () => {
      try {
        if (oversized) throw new Error("Requisição excede 1 MB.");
        const token = (request.headers.authorization || "").replace(/^Bearer /, "");
        const result = await queryDatabase(JSON.parse(raw), token, loadConfig(), process.env, projectDir);
        response.end(JSON.stringify(result));
      } catch (error) {
        response.statusCode = 400;
        // Do not return driver details or administrative connection information to browsers.
        console.error("Moon database:", error.code || error.name);
        response.end(JSON.stringify({ error: "Operação recusada. Verifique login, campos e configuração do banco." }));
      }
    });
    return;
  }
  if (request.method === "POST" && (request.url === "/api/ai/chat" || request.url.startsWith("/api/functions/"))) {
    let raw = "", size = 0, oversized = false;
    request.on("data", (chunk) => { size += chunk.length; if (size > 1048576) {oversized = true; return;} raw += chunk; });
    request.on("end", async () => {
      try {
        if (oversized) throw new Error("Requisição excede 1 MB.");
        const token = (request.headers.authorization || "").replace(/^Bearer /, "");
        const payload = JSON.parse(raw || "{}");
        if (request.url.startsWith("/api/functions/")) {
          const result = await invokeLocalFunction(decodeURIComponent(request.url.slice("/api/functions/".length)), payload, token, loadConfig(), process.env, projectDir, askAi);
          response.statusCode = result.status; response.end(JSON.stringify(result.data)); return;
        }
        if (!token) { response.statusCode = 401; response.end(JSON.stringify({error:"Entre na sua conta para usar o assistente."})); return; }
        await verifyUser(token, loadConfig(), process.env);
        const content = await askAi(Array.isArray(payload.messages) ? payload.messages : []);
        response.end(JSON.stringify({ content }));
      } catch (error) {
        response.statusCode = error instanceof SyntaxError ? 400 : error.status || 502;
        console.error('Moon função/IA:', error.code || error.name);
        response.end(JSON.stringify({ error: error instanceof SyntaxError ? 'Requisição JSON inválida.' : error.publicMessage || "Falha na função/IA local. Execute moon inspect para conferir compatibilidade e configuração." }));
      }
    });
    return;
  }
  const config = loadConfig();
  if (request.url === "/health" || request.url === "/api/health") {
    response.end(JSON.stringify({ ok: true, service: "moon-local-backend" }));
    return;
  }
  if (request.url === "/api/status") {
    response.end(JSON.stringify({
      ok: true,
      sdkVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      provider: config.provider || null,
      databaseConfigured: Boolean(config.provider && config.provider !== "none"),
      aiConfigured: Boolean(process.env.MOON_AI_API_KEY),
    }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "127.0.0.1", () => console.log(`Moon backend escutando em http://localhost:${port}`));
server.on("error", (error) => { console.error(`Moon backend: ${error.message}`); process.exit(1); });
