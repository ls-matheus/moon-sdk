#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const command = process.argv[2] || "help";
const projectDir = resolve(process.argv[3] || ".");
const noDatabase = process.argv.includes("--no-db") || process.argv.includes("--visual");
const configPath = resolve(projectDir, "moon.config.json");
const envPath = resolve(projectDir, ".env.local");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const windows = process.platform === "win32";
const platformCommand = process.platform === "win32" ? "base44.cmd" : "base44";

const print = (message = "") => console.log(message);

async function showPurpleDots() {
  if (!output.isTTY) return;
  const frames = ["·  ", "·· ", "···"];
  for (const frame of frames) {
    output.write(`\r\x1b[35m${frame}\x1b[0m`);
    await new Promise((resolve) => setTimeout(resolve, 140));
  }
  output.write("\r   \r");
}

function startSpinner(message) {
  if (!output.isTTY) return () => {};
  const frames = ["◐", "◓", "◑", "◒"];
  let index = 0;
  output.write(`\x1b[35m${frames[index]}\x1b[0m ${message}`);
  const timer = setInterval(() => {
    index = (index + 1) % frames.length;
    output.write(`\r\x1b[35m${frames[index]}\x1b[0m ${message}`);
  }, 120);
  return (success = true, suffix = "") => {
    clearInterval(timer);
    output.write(`\r${success ? "✓" : "✗"} ${message}${suffix}\x1b[K\n`);
  };
}

function help() {
  print("Moon SDK — ferramentas locais");
  print("\nComandos:");
  print("  init [pasta]       cria uma configuração local");
  print("  login [pasta]      autentica a conta de importação");
  print("  eject [pasta]      importa um projeto para a pasta escolhida");
  print("  link [pasta]       escolhe o banco e prepara o projeto");
  print("  config [pasta]     edita a configuração local");
  print("  doctor [pasta]     verifica a configuração sem conectar em serviços");
  print("  test [pasta]       testa a conexão configurada");
  print("  build              compila o SDK");
  print("  dev [pasta]        inicia o app local definido no package.json");
  print("  start [pasta]      prepara o projeto e inicia o app");
  print("  run [pasta]        configura o projeto e sobe backend + frontend locais");
  print("  run [pasta] --no-db inicia a apresentação sem conectar a nenhum banco");
}

function readConfig() {
  if (!existsSync(configPath)) return null;
  try { return JSON.parse(readFileSync(configPath, "utf8")); }
  catch { throw new Error(`Arquivo inválido: ${configPath}`); }
}

function readProjectEnv() {
  const values = {};
  for (const filename of [".env.local", ".env", ".env.example"]) {
    const path = resolve(projectDir, filename);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match && match[2] && !values[match[1]]) values[match[1]] = parseEnvValue(match[2]);
    }
  }
  return values;
}

function isPlaceholder(value) {
  return !value || /your[-_ ]project|your[-_ ]api|example\.com|change[-_ ]me|replace[-_ ]me|<[^>]+>/i.test(value);
}

function detectDatabase() {
  const values = readProjectEnv();
  let packageText = "";
  const packagePath = resolve(projectDir, "package.json");
  if (existsSync(packagePath)) packageText = readFileSync(packagePath, "utf8").toLowerCase();
  const sourceHints = projectUsesDatabase(projectDir);
  const supabaseUrl = values.MOON_SUPABASE_URL || values.VITE_SUPABASE_URL || values.SUPABASE_URL || "";
  if (!isPlaceholder(supabaseUrl) && (values.VITE_SUPABASE_URL || values.SUPABASE_URL || packageText.includes("@supabase/supabase-js") || sourceHints.supabase)) {
    return { provider: "supabase", values: { MOON_SUPABASE_URL: supabaseUrl, MOON_SUPABASE_ANON_KEY: values.MOON_SUPABASE_ANON_KEY || values.VITE_SUPABASE_ANON_KEY || values.SUPABASE_ANON_KEY || "" } };
  }
  if (!isPlaceholder(values.MOON_FIREBASE_PROJECT_ID || values.FIREBASE_PROJECT_ID) && (values.MOON_FIREBASE_PROJECT_ID || values.FIREBASE_PROJECT_ID || packageText.includes("firebase") || sourceHints.firebase)) {
    return { provider: "firebase", values: Object.fromEntries(["API_KEY", "AUTH_DOMAIN", "PROJECT_ID", "STORAGE_BUCKET", "MESSAGING_SENDER_ID", "APP_ID"].map((key) => [`MOON_FIREBASE_${key}`, values[`MOON_FIREBASE_${key}`] || values[`FIREBASE_${key}`] || ""])) };
  }
  if (!isPlaceholder(values.MOON_DATABASE_URL || values.DATABASE_URL) && (values.MOON_DATABASE_URL || values.DATABASE_URL || packageText.includes("pg") || packageText.includes("mysql2") || sourceHints.sql)) {
    const url = values.MOON_DATABASE_URL || values.DATABASE_URL || "";
    const provider = url.startsWith("mysql") || packageText.includes("mysql2") ? "mysql" : url.startsWith("postgres") || packageText.includes("\"pg\"") ? "postgres" : "sql";
    return { provider, values: { MOON_DATABASE_URL: url } };
  }
  return null;
}

function projectUsesDatabase(directory) {
  const result = { supabase: false, firebase: false, sql: false };
  const ignored = new Set(["node_modules", "dist", ".git", ".next", "build"]);
  const visit = (current) => {
    for (const entry of readdirSync(current)) {
      if (ignored.has(entry)) continue;
      const fullPath = resolve(current, entry);
      const info = statSync(fullPath);
      if (info.isDirectory()) { visit(fullPath); continue; }
      if (!info.isFile() || !/\.(js|jsx|ts|tsx|mjs|json)$/.test(entry)) continue;
      const source = readFileSync(fullPath, "utf8").toLowerCase();
      if (source.includes("supabase")) result.supabase = true;
      if (source.includes("firebase")) result.firebase = true;
      if (source.includes("prisma") || source.includes("drizzle") || source.includes("knex") || source.includes("postgres") || source.includes("mysql")) result.sql = true;
    }
  };
  try { visit(directory); } catch { /* project may be incomplete */ }
  return result;
}

const providers = [
  {
    id: "none", label: "Sem banco por enquanto", mode: "local",
    fields: [],
  },
  {
    id: "supabase", label: "Supabase", mode: "frontend",
    fields: [
      ["MOON_SUPABASE_URL", "URL do projeto", false],
      ["MOON_SUPABASE_ANON_KEY", "chave pública anon", true],
    ],
  },
  {
    id: "firebase", label: "Firebase", mode: "frontend",
    fields: [
      ["MOON_FIREBASE_API_KEY", "API key", true],
      ["MOON_FIREBASE_AUTH_DOMAIN", "Auth domain", false],
      ["MOON_FIREBASE_PROJECT_ID", "Project ID", false],
      ["MOON_FIREBASE_STORAGE_BUCKET", "Storage bucket", false],
      ["MOON_FIREBASE_MESSAGING_SENDER_ID", "Messaging sender ID", false],
      ["MOON_FIREBASE_APP_ID", "App ID", false],
    ],
  },
  {
    id: "postgres", label: "PostgreSQL", mode: "backend",
    fields: [["MOON_DATABASE_URL", "connection string PostgreSQL", true]],
  },
  {
    id: "mysql", label: "MySQL", mode: "backend",
    fields: [["MOON_DATABASE_URL", "connection string MySQL", true]],
  },
  {
    id: "sql", label: "SQL genérico", mode: "backend",
    fields: [["MOON_DATABASE_URL", "connection string SQL", true]],
  },
];

async function askProvider(askLine, fallback = "supabase") {
  print("\nEscolha o banco de dados:");
  providers.forEach((item, index) => print(`  ${index + 1}. ${item.label}`));
  const answer = await askLine(`Número [${providers.findIndex((item) => item.id === fallback) + 1}]`);
  const selected = providers[Number.parseInt(answer.trim(), 10) - 1];
  return selected?.id || fallback;
}

async function askSecret(askLine, label) {
  if (!input.isTTY || !output.isTTY) return askLine(label);
  if (windows) {
    const script = [
      "$value = Read-Host -Prompt $env:MOON_SECRET_PROMPT -AsSecureString",
      "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($value)",
      "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
    ].join("; ");
    return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], {
      encoding: "utf8",
      env: { ...process.env, MOON_SECRET_PROMPT: label },
      stdio: ["inherit", "pipe", "inherit"],
    }).trim();
  }
  try {
    execFileSync("stty", ["-echo"], { stdio: ["inherit", "inherit", "inherit"] });
    const value = await askLine(label);
    execFileSync("stty", ["echo"], { stdio: ["inherit", "inherit", "inherit"] });
    output.write("\n");
    return value;
  } catch (error) {
    try { execFileSync("stty", ["echo"], { stdio: ["inherit", "inherit", "inherit"] }); } catch { /* best effort */ }
    throw error;
  }
}

function writeEnvValues(values, targetPath = envPath) {
  let content = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${JSON.stringify(String(value ?? ""))}`;
    const matcher = new RegExp(`^${key}=.*$`, "m");
    content = matcher.test(content) ? content.replace(matcher, line) : `${content.replace(/\s*$/, "")}\n${line}\n`;
  }
  writeFileSync(targetPath, content.replace(/^\n+/, ""));
}

function withRuntimeAliases(provider, values) {
  if (provider === "supabase") {
    return {
      ...values,
      VITE_SUPABASE_URL: values.MOON_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: values.MOON_SUPABASE_ANON_KEY,
    };
  }
  return values;
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/\\'/g, "'");
  return trimmed;
}

async function configureAi() {
  const rl = createInterface({ input, output });
  const pipedAnswers = !input.isTTY ? readFileSync(0, "utf8").split(/\r?\n/) : null;
  let pipedIndex = 0;
  const askLine = async (label) => pipedAnswers ? (pipedAnswers[pipedIndex++] ?? "") : rl.question(`${label}: `);
  try {
    const answer = (await askLine("Este projeto usa IA. Configurar uma API agora? (S/n)")).trim().toLowerCase();
    if (!["s", "sim", "y", "yes"].includes(answer)) return false;
    const provider = (await askLine("Provedor (openai, anthropic, gemini ou compatível)")).trim();
    const apiKey = (await askLine("Chave da API")).trim();
    const baseUrl = (await askLine("URL base opcional")).trim();
    const model = (await askLine("Modelo opcional")).trim();
    if (!provider || !apiKey) throw new Error("Provedor e chave da API são necessários para configurar IA.");
    writeEnvValues({
      MOON_AI_PROVIDER: provider,
      MOON_AI_API_KEY: apiKey,
      MOON_AI_BASE_URL: baseUrl,
      MOON_AI_MODEL: model,
    });
    print("✓ API de IA salva no .env.local (a chave não é exibida nem enviada ao frontend)");
    return true;
  } finally { rl.close(); }
}

function runLocalProcesses() {
  const serverPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "local-server.mjs");
  const backend = spawn(process.execPath, [serverPath], { cwd: projectDir, stdio: "inherit", env: process.env });
  const frontendDir = findRunnableProject(projectDir);
  if (frontendDir) migrateImportedProject(frontendDir);
  const frontend = frontendDir ? spawn(npmCommand, ["run", "dev"], { cwd: frontendDir, stdio: "inherit", env: process.env, shell: windows }) : null;
  const stop = () => {
    stopProcessTree(backend);
    stopProcessTree(frontend);
  };
  process.once("SIGINT", () => { stop(); process.exit(0); });
  process.once("SIGTERM", () => { stop(); process.exit(0); });
  backend.once("error", (error) => { console.error(`Backend local não iniciou: ${error.message}`); stop(); process.exitCode = 1; });
  backend.once("exit", (code) => { if (code && code !== 143) { if (frontend && !frontend.killed) frontend.kill("SIGTERM"); process.exitCode = code; } });
  if (frontend) frontend.once("error", (error) => { console.error(`Frontend não iniciou: ${error.message}`); stop(); process.exitCode = 1; });
  if (frontend) frontend.once("exit", (code) => { if (code && code !== 0 && code !== 143) console.error(`Frontend encerrou com código ${code}. Verifique a saída do Vite acima.`); });
  print("Backend local: http://localhost:8787");
  if (frontend) print(`Frontend local: http://localhost:5173 (projeto: ${frontendDir})`);
  else print("Frontend local: nenhum script dev encontrado");
}

function stopProcessTree(child) {
  if (!child || child.killed || !child.pid) return;
  if (windows) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function findRunnableProject(directory) {
  const hasDevScript = (candidate) => {
    try {
      const packagePath = resolve(candidate, "package.json");
      if (!existsSync(packagePath)) return false;
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      return Boolean(packageJson.scripts?.dev);
    } catch { return false; }
  };
  if (hasDevScript(directory)) return directory;
  try {
    for (const entry of readdirSync(directory)) {
      if (["node_modules", "dist", ".git"].includes(entry)) continue;
      const candidate = resolve(directory, entry);
      if (statSync(candidate).isDirectory() && hasDevScript(candidate)) return candidate;
    }
  } catch { /* project may be incomplete */ }
  return null;
}

function migrateImportedProject(appDir) {
  const packagePath = resolve(appDir, "package.json");
  const clientPath = ["src/api/base44Client.js", "src/api/base44Client.ts", "src/lib/base44Client.js", "src/lib/base44Client.ts"]
    .map((relativePath) => resolve(appDir, relativePath)).find((candidate) => existsSync(candidate));
  if (!existsSync(packagePath)) return;
  const sdkPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const install = spawnSync(npmCommand, ["install", "--save", pathToFileURL(sdkPath).href, "@supabase/supabase-js"], { cwd: appDir, stdio: "inherit", shell: windows });
  if (install.status !== 0) throw new Error("não foi possível instalar o Moon no projeto importado");
  const activeConfig = readConfig();
  writeEnvValues(withRuntimeAliases(activeConfig.provider, { ...readEnvValues(activeConfig.env || []), VITE_MOON_DEV_AUTH_BYPASS: "true" }), resolve(appDir, ".env.local"));
  const viteConfigPath = ["vite.config.js", "vite.config.mjs", "vite.config.ts"]
    .map((relativePath) => resolve(appDir, relativePath)).find((candidate) => existsSync(candidate));
  if (viteConfigPath && (!readFileSync(viteConfigPath, "utf8").includes("alias: { \"@\":") || readFileSync(viteConfigPath, "utf8").includes("@base44/vite-plugin") || !readFileSync(viteConfigPath, "utf8").includes("127.0.0.1:8787"))) {
    writeFileSync(viteConfigPath, `import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
`);
    const uninstall = spawnSync(npmCommand, ["uninstall", "@base44/vite-plugin"], { cwd: appDir, stdio: "inherit", shell: windows });
    if (uninstall.status === 0) print("✓ Plugin de desenvolvimento antigo removido do Vite");
  }
  if (!clientPath) return;
  const source = readFileSync(clientPath, "utf8");
  if (!source.includes("@base44/sdk") && !source.includes("Configure a API de IA") && !source.includes("base44.app")) return;
  writeFileSync(clientPath, `import { createClient as createMoonClient, createMemoryAdapter } from "@moon/sdk";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabase = supabaseUrl ? createSupabaseClient(supabaseUrl, import.meta.env.VITE_SUPABASE_ANON_KEY || "") : null;
const devAuthBypass = import.meta.env.VITE_MOON_DEV_AUTH_BYPASS === "true" && import.meta.env.MODE !== "production";
const localUserKey = "moon-dev-user";
const localUser = () => { try { return JSON.parse(localStorage.getItem(localUserKey) || "null"); } catch { return null; } };
const localSession = () => { const user = localUser(); return user ? { user, access_token: "moon-dev-session" } : null; };
const auth = {
  async getSession() { if (devAuthBypass) return { session: localSession() }; const { data, error } = await supabase.auth.getSession(); if (error) throw error; return { session: data.session }; },
  async getUser() { if (devAuthBypass) return { user: localUser() }; const { data, error } = await supabase.auth.getUser(); if (error && error.name !== "AuthSessionMissingError") throw error; return { user: data.user }; },
  async signInWithPassword(credentials) { if (devAuthBypass) { const user = { id: "dev-" + encodeURIComponent(credentials.email), email: credentials.email }; localStorage.setItem(localUserKey, JSON.stringify(user)); return { user, session: localSession() }; } const { data, error } = await supabase.auth.signInWithPassword(credentials); if (error) throw error; return data; },
  async signUp(credentials) { if (devAuthBypass) { const user = { id: "dev-" + encodeURIComponent(credentials.email), email: credentials.email }; localStorage.setItem(localUserKey, JSON.stringify(user)); return { user, session: localSession() }; } const { data, error } = await supabase.auth.signUp({ ...credentials, options: { ...(credentials.options || {}), emailRedirectTo: window.location.origin + "/login" } }); if (error) throw error; return data; },
  async signOut() { if (devAuthBypass) { localStorage.removeItem(localUserKey); return; } const { error } = await supabase.auth.signOut(); if (error) throw error; },
  async updateUser(attributes) { const { data, error } = await supabase.auth.updateUser(attributes); if (error) throw error; return { user: data.user }; },
  async resetPasswordForEmail(email, options) { const { error } = await supabase.auth.resetPasswordForEmail(email, options); if (error) throw error; },
  async signInWithOAuth(options) { const { error } = await supabase.auth.signInWithOAuth(options); if (error) throw error; },
  async verifyOtp(params) { if (devAuthBypass) return { user: localUser(), session: localSession() }; const { data, error } = await supabase.auth.verifyOtp({ email: params.email, token: params.otpCode || params.token, type: params.type || "signup" }); if (error) throw error; return data; },
  async resend(params) { if (devAuthBypass) return; const { error } = await supabase.auth.resend({ email: params.email, type: params.type || "signup" }); if (error) throw error; },
  onAuthStateChange(callback) { const { data } = supabase.auth.onAuthStateChange((event, session) => callback({ event, session })); return data.subscription; },
};
const database = devAuthBypass ? createMemoryAdapter(localStorage) : supabase;
const sdk = createMoonClient({ from: (table) => database.from(table), auth });
export const base44 = {
  auth: {
    me: () => sdk.auth.me(), isAuthenticated: () => sdk.auth.isAuthenticated(),
    loginViaEmailPassword: (email, password) => sdk.auth.loginViaEmailPassword(email, password),
    register: (params) => sdk.auth.register(params), updateMe: (data) => sdk.auth.updateMe(data),
    resetPasswordRequest: (email) => sdk.auth.resetPasswordForEmail(email), resetPassword: () => Promise.reject(new Error("Redefinição por token deve ser adaptada ao provedor escolhido.")),
    logout: () => sdk.auth.logout(), setToken: (token) => sdk.auth.setToken(token),
    loginWithProvider: (provider, redirectTo) => sdk.auth.loginWithProvider(provider, redirectTo),
    verifyOtp: (params) => auth.verifyOtp(params), resendOtp: (email) => auth.resend({ email, type: "signup" }),
    onAuthStateChange: (callback) => sdk.auth.onChange(callback),
    redirectToLogin: (url) => { window.location.href = "/login?returnTo=" + encodeURIComponent(url || window.location.href); },
  },
  app: { getPublicSettings: async () => ({}) },
  entities: sdk.entities,
  agents: {
    createConversation: async () => ({ id: crypto.randomUUID(), messages: [] }),
    addMessage: async (conversation, message) => { const response = await fetch("/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [...(conversation.messages || []), message] }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Falha ao consultar a IA."); const reply = { role: "assistant", content: data.content }; conversation.messages = [...(conversation.messages || []), message, reply]; return conversation; },
    subscribeToConversation: (id, callback) => { void id; void callback; return () => {}; },
  },
};
`);
  const registerPath = resolve(appDir, "src/pages/Register.jsx");
  if (existsSync(registerPath)) {
    const registerSource = readFileSync(registerPath, "utf8");
    writeFileSync(registerPath, registerSource.replace("setShowOtp(true);", "if (import.meta.env.VITE_MOON_DEV_AUTH_BYPASS === \"true\") window.location.href = safeReturnTo(); else setShowOtp(true);"));
  }
  print(`✓ Integração antiga substituída pelo Moon em ${appDir}`);
}

function readEnvValues(keys) {
  const content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  return Object.fromEntries(keys.map((key) => {
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return [key, match ? parseEnvValue(match[1]) : ""];
  }));
}

function findProjectSchema(provider = "supabase") {
  const candidates = provider === "supabase"
    ? ["supabase/schema.sql", "moon/schema.supabase.sql", "schema.sql"]
    : [`moon/schema.${provider}.sql`, "moon/schema.sql"];
  for (const relativePath of candidates) {
    const path = resolve(projectDir, relativePath);
    if (existsSync(path)) return path;
  }
  return null;
}

function inferProjectSchema(provider = "postgres") {
  const ignored = new Set(["node_modules", "dist", ".git", ".next", "build"]);
  const entities = new Map();
  const visit = (directoryPath) => {
    for (const entry of readdirSync(directoryPath)) {
      if (ignored.has(entry)) continue;
      const fullPath = resolve(directoryPath, entry);
      const info = statSync(fullPath);
      if (info.isDirectory()) { visit(fullPath); continue; }
      if (!info.isFile() || !/\.(js|jsx|ts|tsx|mjs)$/.test(entry)) continue;
      const source = readFileSync(fullPath, "utf8");
      const entityPattern = /entities\.([A-Za-z0-9_]+)\.(?:create|update)\s*\(([\s\S]*?)\)/g;
      for (const match of source.matchAll(entityPattern)) {
        const table = match[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
        const fields = entities.get(table) || new Set();
        for (const field of match[2].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) fields.add(field[1]);
        entities.set(table, fields);
      }
    }
  };
  try { visit(projectDir); } catch { return ""; }
  if (!entities.size) return "";

  const usesAuth = projectUsesAuth();
  const sql = [
    "-- Schema gerado automaticamente pelo Moon a partir do código do projeto.",
    ...(provider === "postgres" || provider === "supabase" ? ["create extension if not exists pgcrypto;"] : []),
    "",
  ];
  for (const [table, fields] of entities) {
    fields.add("id");
    if (usesAuth) fields.add("user_id");
    fields.add("created_at");
    fields.add("updated_at");
    const columns = [...fields].map((field) => {
      const safe = field.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
      if (safe === "id") return provider === "mysql" ? "  id char(36) primary key" : "  id uuid primary key default gen_random_uuid()";
      if (safe === "user_id") return provider === "supabase" || provider === "postgres" ? "  user_id uuid not null references auth.users(id) on delete cascade" : "  user_id varchar(255) not null";
      if (["created_at", "updated_at"].includes(safe)) return `  ${safe} ${provider === "mysql" ? "timestamp" : "timestamptz"} not null default current_timestamp`;
      if (/^(is_|has_|can_|should_|pinned|active|enabled|completed|done)/.test(safe)) return `  ${safe} boolean not null default false`;
      return `  ${safe} text`;
    });
    const qualifiedTable = provider === "supabase" || provider === "postgres" ? `public.${table}` : table;
    sql.push(`create table if not exists ${qualifiedTable} (\n${columns.join(",\n")}\n);`);
    if (usesAuth && (provider === "supabase" || provider === "postgres")) {
      sql.push(`alter table public.${table} enable row level security;`);
      sql.push(`drop policy if exists "Moon users own ${table}" on public.${table};`);
      sql.push(`create policy "Moon users own ${table}" on public.${table} for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`);
    }
    sql.push("");
  }
  return `${sql.join("\n")}\n`.replace(/gen_random_uuid\(\)/g, provider === "mysql" ? "(UUID())" : "gen_random_uuid()");
}

function projectUsesAuth() {
  const ignored = new Set(["node_modules", "dist", ".git", ".next", "build"]);
  const visit = (directoryPath) => {
    for (const entry of readdirSync(directoryPath)) {
      if (ignored.has(entry)) continue;
      const fullPath = resolve(directoryPath, entry);
      const info = statSync(fullPath);
      if (info.isDirectory() && visit(fullPath)) return true;
      if (info.isFile() && /\.(js|jsx|ts|tsx|mjs)$/.test(entry) && /\b(auth|entities\.)/i.test(readFileSync(fullPath, "utf8"))) return true;
    }
    return false;
  };
  try { return visit(projectDir); } catch { return false; }
}

function ensureProjectSchema(provider = "supabase") {
  const existing = findProjectSchema(provider);
  if (existing) return existing;
  if (provider === "firebase") {
    const path = resolve(projectDir, "moon/firestore.rules");
    const folder = resolve(projectDir, "moon");
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
    writeFileSync(path, `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{collection}/{document} {\n      allow create: if request.auth != null && request.resource.data.user_id == request.auth.uid;\n      allow read, update, delete: if request.auth != null && resource.data.user_id == request.auth.uid;\n    }\n  }\n}\n`);
    print(`✓ Regras do Firebase geradas automaticamente em ${path}`);
    return path;
  }
  const generated = inferProjectSchema(provider === "supabase" ? "supabase" : provider);
  if (!generated) return null;
  const path = resolve(projectDir, `moon/schema.${provider}.sql`);
  const folder = resolve(projectDir, "moon");
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  writeFileSync(path, generated);
  print(`✓ Schema gerado automaticamente em ${path}`);
  return path;
}

async function provisionDatabase(provider) {
  if (provider === "none") return true;
  const schemaPath = ensureProjectSchema(provider);
  if (!schemaPath) {
    print("ℹ Nenhuma entidade foi encontrada para gerar estrutura de banco.");
    return true;
  }
  if (provider === "firebase") {
    print("✓ Firebase não exige schema de tabelas; as coleções são criadas no primeiro uso.");
    print(`  Regras geradas em ${schemaPath}; publique-as com a CLI do Firebase quando desejar.`);
    return true;
  }
  if (!["supabase", "postgres", "mysql"].includes(provider)) {
    print(`✓ Estrutura gerada em ${schemaPath}; SQL genérico requer aplicação pelo driver configurado.`);
    return true;
  }

  const envValues = readProjectEnv();
  const existingDbUrl = envValues.MOON_DATABASE_URL || envValues.SUPABASE_DB_URL;
  if (!existingDbUrl) {
    print(`✓ Schema encontrado: ${schemaPath}`);
    print(`ℹ ${provider} precisa de uma connection string administrativa para criar a estrutura.`);
    print("  A URL pública + chave anon continuam sendo suficientes para o uso normal do app.");
    print("  Para aplicar automaticamente depois, salve MOON_DATABASE_URL no .env.local e rode moon run novamente.");
    return true;
  }

  if (provider === "supabase" || provider === "postgres") {
    try {
      const { Client } = await import("pg");
      const client = new Client({ connectionString: existingDbUrl, connectionTimeoutMillis: 10000 });
      await client.connect();
      const schema = readFileSync(schemaPath, "utf8");
      const idempotentSchema = schema.replace(/create policy\s+"([^"]+)"\s+on\s+([^\s(]+)[^;]*;/gi, (statement, name, table) => `drop policy if exists "${name}" on ${table};\n${statement}`);
      await client.query(idempotentSchema);
      await client.end();
      print("✓ Banco preparado automaticamente a partir do schema do projeto");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      print(`✗ Falha ao aplicar o schema do projeto: ${message}`);
      return false;
    }
  }
  const executable = "mysql";
  const args = [existingDbUrl, "--batch"];
  const psql = spawnSync(executable, args, { input: readFileSync(schemaPath, "utf8"), encoding: "utf8" });
  if (psql.error?.code === "ENOENT") {
    print(`✗ A estrutura não foi aplicada: o comando ${executable} não está instalado.`);
    print(`  Instale o cliente de ${provider} e rode moon run novamente.`);
    return false;
  }
  if (psql.status !== 0) {
    print(`✗ Falha ao aplicar o schema do projeto${psql.stderr ? `: ${psql.stderr.trim()}` : "."}`);
    return false;
  }
  print("✓ Banco preparado automaticamente a partir do schema do projeto");
  return true;
}

async function configureSchemaAccess(provider) {
  if (!["supabase", "postgres", "mysql"].includes(provider) || !ensureProjectSchema(provider) || !input.isTTY || !output.isTTY) return;
  const values = readProjectEnv();
  const existingDbUrl = values.MOON_DATABASE_URL || values.SUPABASE_DB_URL;
  if (existingDbUrl && !/[\\[\]]/.test(existingDbUrl)) return;
  const rl = createInterface({ input, output });
  const askLine = (label) => rl.question(`${label}: `);
  try {
    const answer = (await askLine("Preparar tabelas e políticas automaticamente agora? (s/N)")).trim().toLowerCase();
    if (!["s", "sim", "y", "yes"].includes(answer)) return;
    const dbUrl = (await askSecret(askLine, "Connection string administrativa do Supabase")).trim();
    if (!dbUrl) return;
    writeEnvValues({ MOON_DATABASE_URL: dbUrl });
    print("✓ Credencial administrativa salva somente no .env.local");
  } finally { rl.close(); }
}

function loadEnvFile() {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = parseEnvValue(match[2]);
  }
}

function projectUsesAi(directory = projectDir) {
  const markers = ["invokellm", "aigateway", "createopenai", "openai", "anthropic", "gemini", "generatetext", "generateobject", "streamtext", "chatbot", "assistant", "agent"];
  const ignored = new Set(["node_modules", "dist", ".git", ".next", "build"]);
  const extensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".json", ".jsonc"]);
  const visit = (directoryPath) => {
    for (const entry of readdirSync(directoryPath)) {
      if (ignored.has(entry)) continue;
      const fullPath = resolve(directoryPath, entry);
      const info = statSync(fullPath);
      if (info.isDirectory() && visit(fullPath)) return true;
      const extension = entry.slice(entry.lastIndexOf("."));
      if (!info.isFile() || !extensions.has(extension)) continue;
      if (markers.some((marker) => readFileSync(fullPath, "utf8").toLowerCase().includes(marker))) return true;
    }
    return false;
  };
  try { return visit(directory); } catch { return false; }
}

async function testConnection(provider, values) {
  const selected = providers.find((item) => item.id === provider);
  if (provider === "none") return { ok: true, message: "nenhum banco configurado; o projeto será executado localmente" };
  if (!selected) return { ok: false, message: "banco não reconhecido na configuração" };
  const missing = selected.fields.filter(([key]) => !values[key]).map(([key]) => key);
  if (missing.length) return { ok: false, message: `variáveis ausentes: ${missing.join(", ")}` };

  if (provider === "supabase") {
    const supabaseUrl = new URL(values.MOON_SUPABASE_URL);
    if (!['http:', 'https:'].includes(supabaseUrl.protocol)) return { ok: false, message: "URL do Supabase precisa usar http ou https" };
    const response = await fetch(`${values.MOON_SUPABASE_URL.replace(/\/$/, "")}/auth/v1/settings`, {
      headers: { apikey: values.MOON_SUPABASE_ANON_KEY, Authorization: `Bearer ${values.MOON_SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    return response.ok
      ? { ok: true, message: "Supabase respondeu e a chave pública foi aceita" }
      : response.status === 401
        ? { ok: false, message: "Supabase respondeu HTTP 401: chave pública inválida ou incorreta" }
        : { ok: false, message: `Supabase respondeu HTTP ${response.status}` };
  }

  if (provider === "firebase") {
    const response = await fetch(`https://firebase.googleapis.com/v1beta/projects/${values.MOON_FIREBASE_PROJECT_ID}`, {
      signal: AbortSignal.timeout(8000),
    });
    return response.ok
      ? { ok: true, message: "projeto Firebase encontrado (credenciais do SDK serão validadas ao inicializar o app)" }
      : { ok: false, message: `Firebase respondeu HTTP ${response.status}` };
  }

  const raw = values.MOON_DATABASE_URL;
  const parsed = new URL(raw.replace(/^sql:\/\//, "tcp://"));
  const port = Number(parsed.port || (provider === "postgres" ? 5432 : provider === "mysql" ? 3306 : 1433));
  return new Promise((resolve) => {
    const socket = createConnection({ host: parsed.hostname, port, timeout: 8000 });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => finish({ ok: true, message: `host alcançável em ${parsed.hostname}:${port} (autenticação será validada pelo driver do backend)` }));
    socket.once("timeout", () => finish({ ok: false, message: `tempo esgotado ao conectar em ${parsed.hostname}:${port}` }));
    socket.once("error", (error) => finish({ ok: false, message: `${error.code || "erro de rede"} em ${parsed.hostname}:${port}` }));
  });
}

async function testConfigured() {
  const config = readConfig();
  if (!config) { print(`Configuração ausente: ${configPath}`); process.exitCode = 1; return false; }
  const values = readEnvValues(config.env || []);
  const stopSpinner = startSpinner(`Verificando conexão com ${config.provider}`);
  try {
    const result = await testConnection(config.provider, values);
    stopSpinner(result.ok, result.ok ? "" : ` — ${result.message}`);
    if (result.ok) print(`  ${result.message}`);
    if (!result.ok) process.exitCode = 1;
    return result.ok;
  } catch (error) {
    const detail = error instanceof Error && error.cause?.code ? ` (${error.cause.code})` : "";
    const message = `não foi possível conectar: ${error instanceof Error ? error.message : String(error)}${detail}`;
    stopSpinner(false, ` — ${message}`);
    print(`  ${message}`);
    process.exitCode = 1;
    return false;
  }
}

function validateProvider(provider, values) {
  if (provider === "supabase" && values.MOON_SUPABASE_URL) {
    try { new URL(values.MOON_SUPABASE_URL); }
    catch { throw new Error("A URL do Supabase é inválida."); }
  }
  if (provider === "firebase" && values.MOON_FIREBASE_PROJECT_ID && !/^[a-z0-9-]+$/.test(values.MOON_FIREBASE_PROJECT_ID)) {
    throw new Error("O Project ID do Firebase deve conter apenas letras minúsculas, números e hífens.");
  }
  if (["postgres", "mysql", "sql"].includes(provider) && values.MOON_DATABASE_URL) {
    const expected = provider === "postgres" ? "postgres" : provider === "mysql" ? "mysql" : "";
    if (expected && !values.MOON_DATABASE_URL.startsWith(`${expected}://`)) {
      throw new Error(`A connection string precisa começar com ${expected}://`);
    }
  }
}

async function configure({ startAfter = false } = {}) {
  await showPurpleDots();
  const current = readConfig() || {};
  const rl = createInterface({ input, output });
  const pipedAnswers = !input.isTTY ? readFileSync(0, "utf8").split(/\r?\n/) : null;
  let pipedIndex = 0;
  const askLine = async (label) => pipedAnswers ? (pipedAnswers[pipedIndex++] ?? "") : rl.question(`${label}: `);
  const ask = async (label, fallback = "") => (await askLine(`${label}${fallback ? ` [${fallback}]` : ""}`)).trim() || fallback;
  try {
    const provider = await askProvider(askLine, current.provider || "supabase");
    const selected = providers.find((item) => item.id === provider);
    const values = {};
    for (const [key, label, secret] of selected.fields) values[key] = secret ? await askSecret(askLine, `${label} (opcional)`) : await ask(label, "");
    validateProvider(provider, values);
    const config = {
      version: 1,
      provider,
      mode: selected.mode,
      adapter: `@moon/sdk/${provider}`,
      env: selected.fields.map(([key]) => key),
      configuredAt: new Date().toISOString(),
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    writeEnvValues(withRuntimeAliases(provider, values));
    print(`Configuração salva em ${configPath}`);
    print(`Adaptador selecionado: ${selected.label}`);
    try {
      const result = await testConnection(provider, values);
      print(`${result.ok ? "✓" : "✗"} ${result.message}`);
      if (!result.ok) process.exitCode = 1;
      else print("O projeto está pronto para usar este banco.");
    } catch (error) {
      print(`✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  } finally { rl.close(); }
  if (startAfter) npm("dev");
}

function adoptDetectedDatabase(detected) {
  const selected = providers.find((item) => item.id === detected.provider);
  writeEnvValues(withRuntimeAliases(detected.provider, detected.values));
  writeFileSync(configPath, `${JSON.stringify({
    version: 1,
    provider: selected.id,
    mode: selected.mode,
    adapter: `@moon/sdk/${selected.id}`,
    env: selected.fields.map(([key]) => key),
    detected: true,
    configuredAt: new Date().toISOString(),
  }, null, 2)}\n`);
  print(`✓ Banco detectado no projeto: ${selected.label}`);
}

function doctor() {
  const config = readConfig();
  if (!config) { print(`Configuração ausente: ${configPath}`); process.exitCode = 1; return; }
  const providers = new Set(["none", "supabase", "firebase", "postgres", "mysql", "sql"]);
  const valid = providers.has(config.provider);
  print(`Arquivo: ${configPath}`);
  print(`Banco: ${config.provider || "não definido"}`);
  print(`Status: ${valid ? "válido" : "banco não reconhecido"}`);
  if (valid && config.mode === "backend") print("Segurança: conexão somente no backend");
  if (valid && config.mode === "frontend") print("Segurança: configuração pública + regras do provedor");
  if (valid && config.provider === "none") print("Banco: ignorado por escolha do usuário");
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const envValues = readEnvValues(config.env || []);
  const missing = (config.env || []).filter((key) => isPlaceholder(envValues[key]));
  if (missing.length) {
    print(`Variáveis ausentes ou de exemplo: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else if (valid) print("Variáveis: completas");
  if (!valid) process.exitCode = 1;
}

function npm(script, cwd = projectDir) {
  const result = spawnSync(npmCommand, ["run", script], { cwd, stdio: "inherit", shell: windows });
  process.exitCode = result.status ?? 1;
}

function importFromPlatform(args) {
  print("\nModo de importação temporário: a autenticação e o download são feitos pelo conector oficial.");
  print(`Iniciando conector oficial: ${npxCommand} --yes base44 ${args.join(" ")}`);
  let result = spawnSync(npxCommand, ["--yes", "base44", ...args], { cwd: projectDir, stdio: "inherit", shell: windows });
  if (result.error?.code === "ENOENT") {
    print("npx não encontrado; tentando o CLI oficial instalado globalmente...");
    result = spawnSync(platformCommand, args, { cwd: projectDir, stdio: "inherit", shell: windows });
  }
  if (result.error) console.error(`Não foi possível iniciar o conector oficial: ${result.error.message}`);
  if (result.status == null && !result.error) console.error("O conector oficial foi encerrado sem retornar resultado.");
  if (result.status !== 0 && result.status != null) console.error(`O conector oficial encerrou com código ${result.status}.`);
  process.exitCode = result.status ?? 1;
}

function isMoonSdkDirectory() {
  const packagePath = resolve(projectDir, "package.json");
  if (!existsSync(packagePath)) return false;
  try { return JSON.parse(readFileSync(packagePath, "utf8")).name === "@moon/sdk"; } catch { return false; }
}

if (["run", "start", "dev", "link", "init", "config"].includes(command) && isMoonSdkDirectory()) {
  print("✗ Esta é a pasta do SDK Moon, não a pasta de um aplicativo.");
  print("Entre na pasta do projeto exportado e rode: moon run .");
  process.exitCode = 1;
} else if (command === "help" || command === "--help" || command === "-h") help();
else if (command === "init" || command === "config" || command === "link") await configure({ startAfter: false });
else if (command === "login") importFromPlatform(["login"]);
else if (command === "eject") importFromPlatform(["eject"]);
else if (command === "doctor") doctor();
else if (command === "test") await testConfigured();
else if (command === "build") npm("build", resolve(fileURLToPath(new URL(".", import.meta.url)), ".."));
else if (command === "dev") npm("dev");
else if (command === "start") {
  if (readConfig()) npm("dev");
  else await configure({ startAfter: true });
}
else if (command === "run") {
  if (noDatabase) {
    const existingConfig = readConfig();
    if (!existingConfig) {
      writeFileSync(configPath, `${JSON.stringify({ version: 1, provider: "none", mode: "local", adapter: "@moon/sdk/none", env: [], configuredAt: new Date().toISOString() }, null, 2)}\n`);
    }
    const activeConfig = readConfig();
    writeEnvValues(withRuntimeAliases("none", { ...readEnvValues(activeConfig.env || []), VITE_MOON_PROVIDER: "none", VITE_MOON_DEV_AUTH_BYPASS: "true" }));
    loadEnvFile();
    print("✓ Banco ignorado: modo visual local ativo (nenhuma requisição de banco será feita)");
    const aiRequired = projectUsesAi();
    if (aiRequired && process.env.MOON_AI_API_KEY) print("✓ IA detectada e já configurada; mantendo a chave existente");
    else if (aiRequired) await configureAi();
    else print("✓ Nenhum recurso de IA detectado; configuração de IA ignorada");
    runLocalProcesses();
  } else {
  if (!readConfig()) {
    const detected = detectDatabase();
    if (detected) adoptDetectedDatabase(detected);
    else await configure({ startAfter: false });
  }
  let connected = await testConfigured();
  if (!connected && input.isTTY && output.isTTY) {
    print("\nA configuração atual não funcionou. Vamos configurar o banco novamente.");
    await configure({ startAfter: false });
    connected = await testConfigured();
  }
  if (connected) {
    const activeConfig = readConfig();
    writeEnvValues(withRuntimeAliases(activeConfig.provider, { ...readEnvValues(activeConfig.env || []), VITE_MOON_PROVIDER: activeConfig.provider, VITE_MOON_DEV_AUTH_BYPASS: "true" }));
    loadEnvFile();
    ensureProjectSchema(readConfig().provider);
    await configureSchemaAccess(readConfig().provider);
    if (!(await provisionDatabase(readConfig().provider))) process.exitCode = 1;
    else {
    const aiRequired = projectUsesAi();
    if (aiRequired && process.env.MOON_AI_API_KEY) print("✓ IA detectada e já configurada; mantendo a chave existente");
    else if (aiRequired) await configureAi();
    else print("✓ Nenhum recurso de IA detectado; configuração de IA ignorada");
    runLocalProcesses();
    }
  }
  }
}
else { print(`Comando desconhecido: ${command}`); help(); process.exitCode = 1; }
