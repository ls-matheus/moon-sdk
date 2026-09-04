#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const port = Number(process.env.MOON_BACKEND_PORT || 8787);
const projectDir = process.cwd();
const configPath = resolve(projectDir, "moon.config.json");

function loadConfig() {
  if (!existsSync(configPath)) return {};
  try { return JSON.parse(readFileSync(configPath, "utf8")); } catch { return {}; }
}

async function askAi(messages) {
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
    url = `${base.replace(/\/$/, "")}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    headers = { "Content-Type": "application/json" };
    body = { contents: messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })) };
  }
  const result = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error?.message || data.message || `IA respondeu HTTP ${result.status}`);
  const content = provider === "anthropic" ? data.content?.[0]?.text : provider === "gemini" ? data.candidates?.[0]?.content?.parts?.[0]?.text : data.choices?.[0]?.message?.content;
  if (!content) throw new Error("A IA não retornou conteúdo");
  return content;
}

const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  const origin = request.headers.origin || "";
  if (/^https?:\/\/localhost:\d+$/.test(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
  if (request.method === "POST" && request.url === "/api/ai/chat") {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", async () => {
      try {
        const payload = JSON.parse(raw || "{}");
        const content = await askAi(Array.isArray(payload.messages) ? payload.messages : []);
        response.end(JSON.stringify({ content }));
      } catch (error) {
        response.statusCode = 502;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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
