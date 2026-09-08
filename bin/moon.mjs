#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { withRuntimeAliases } from "./runtime-env.mjs";
import { importNetworkEnv } from "./import-network.mjs";

const command = process.argv[2] || "help";
const subcommand = command === "sync" || command === "db" && ["diff", "migrate"].includes(process.argv[3]) ? process.argv[3] : null;
const directoryArg = process.argv[subcommand ? 4 : 3];
const projectDir = resolve(directoryArg && !directoryArg.startsWith("--") ? directoryArg : ".");
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
  print("  inspect [pasta]    análise local de compatibilidade, sem alterar arquivos");
  print("  db [pasta]         assistente de criação e validação do banco (--plan apenas gera o plano)");
  print("Moon SDK — ferramentas locais");
  print("\nComandos:");
  print("  sync init|status|push|pull [pasta]  sincronização protegida com GitHub/main");
  print("  db diff|migrate [pasta]  revisão de schema proposto (--apply para aplicar migração suportada)");
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
  print("  run [pasta] --network inicia o frontend acessível na rede local");
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
  const ignored = new Set(["node_modules", "dist", ".git", ".moon", ".next", "build"]);
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
  if (!windows) chmodSync(targetPath, 0o600);
  const ignorePath = resolve(targetPath, "..", ".gitignore");
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  if (!ignore.split(/\r?\n/).includes(".env.local")) writeFileSync(ignorePath, ignore.trimEnd() + "\n.env.local\n");
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
    const apiKey = (await askSecret(askLine, "Chave da API")).trim();
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

async function runLocalProcesses() {
  // configureAi can save credentials after the first environment load.
  loadEnvFile();
  const network = process.argv.includes("--network");
  const backendPort = Number(process.env.MOON_BACKEND_PORT || 8787);
  const frontendPort = Number(process.env.MOON_FRONTEND_PORT || 5173);
  const { ensurePortAvailable } = await import("./runtime-ports.mjs");
  await ensurePortAvailable(backendPort);
  await ensurePortAvailable(frontendPort, network ? "0.0.0.0" : "127.0.0.1");
  process.env.MOON_NETWORK = String(network);
  const serverPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "local-server.mjs");
  let frontendDir = findRunnableProject(projectDir);
  if (frontendDir) {
    const { prepareLocalRuntime } = await import("./local-runtime.mjs");
    frontendDir = prepareLocalRuntime(frontendDir);
    print("Preparando cópia de execução local; os arquivos compartilhados com Base44 serão preservados.");
    await migrateImportedProject(frontendDir);
  }
  const backend = spawn(process.execPath, [serverPath], { cwd: projectDir, stdio: "inherit", env: process.env });
  const frontendArgs = ["run", "dev"];
  if (network) frontendArgs.push("--", "--host", "0.0.0.0");
  const frontend = frontendDir ? spawn(npmCommand, frontendArgs, { cwd: frontendDir, stdio: "inherit", env: process.env, shell: windows }) : null;
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
  print(`Backend local: http://localhost:${backendPort}`);
  if (frontend) print(`Frontend ${network ? "na rede: use o IP do computador na porta 5173" : "local: confira o endereço mostrado pelo Vite"} (projeto: ${frontendDir})`);
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
      if (["node_modules", "dist", ".git", ".moon"].includes(entry)) continue;
      const candidate = resolve(directory, entry);
      if (statSync(candidate).isDirectory() && hasDevScript(candidate)) return candidate;
    }
  } catch { /* project may be incomplete */ }
  return null;
}

async function migrateImportedProject(appDir) {
  const packagePath = resolve(appDir, "package.json");
  if (!existsSync(packagePath)) return;
  const activeConfig = readConfig();
  const provider = noDatabase ? "none" : activeConfig.provider;
  const { discoverSchema } = await import("./database-schema.mjs");
  const schema = provider === 'none' ? null : discoverSchema(projectDir)?.schema;
  const publicEntities = Object.entries(schema?.entities || {}).filter(([, entity]) => entity.access === "public").map(([name]) => name);
  writeEnvValues(withRuntimeAliases(provider, { ...readEnvValues(activeConfig.env || []), ...(activeConfig.authProvider ? { MOON_AUTH_PROVIDER: activeConfig.authProvider } : {}) }), resolve(appDir, ".env.local"));
  const { installPortableRuntime } = await import("./runtime-vite.mjs");
  installPortableRuntime(appDir, { ...activeConfig, provider, publicEntities, frontendPort: process.env.MOON_FRONTEND_PORT, backendPort: process.env.MOON_BACKEND_PORT });
  const sdkPath = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const install = spawnSync(npmCommand, ["install", "--save", windows ? '\"' + sdkPath + '\"' : sdkPath], { cwd: appDir, stdio: "inherit", shell: windows });
  if (install.status !== 0) throw new Error("N?o foi poss?vel instalar o Moon no projeto importado.");
  print("SDK adaptado na c?pia local; configura??o do Vite e m?dulos do aplicativo preservados.");
}

function readEnvValues(keys) {
  const content = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  return Object.fromEntries(keys.map((key) => {
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return [key, match ? parseEnvValue(match[1]) : ""];
  }));
}

async function setupDatabase() {
  const { databaseWizard } = await import("./database-wizard.mjs");
  const rl = createInterface({ input, output });
  const lines = !input.isTTY ? readFileSync(0, "utf8").split(/\r?\n/) : null;
  let index = 0;
  const ask = async (label) => {
    if (lines) {
      if (index >= lines.length) throw new Error("Respostas insuficientes. Rode moon db em um terminal interativo.");
      return lines[index++];
    }
    return rl.question(label + ": ");
  };
  try {
    return await databaseWizard({
      directory: projectDir, ask, secret: label => askSecret(ask, label),
      config: readConfig() || {}, env: readProjectEnv(), print,
      planOnly: process.argv.includes("--plan"),
      saveEnv: values => writeEnvValues(withRuntimeAliases(values.MOON_SUPABASE_URL ? "supabase" : "", values)),
      saveConfig: config => writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n"),
    });
  } finally { rl.close(); }
}

async function provisionDatabase(provider) {
  if (provider === "none") return true;
  const { discoverSchema } = await import("./database-schema.mjs");
  const schema = discoverSchema(projectDir)?.schema;
  if (!schema) throw new Error("Schema comum ausente. Execute moon db . para definir campos e criar a estrutura.");
  if (provider === "firebase") {
    const reportPath = resolve(projectDir, "moon/database-report.json");
    if (!existsSync(reportPath)) throw new Error("Execute moon db . para publicar as regras e verificar o Firestore.");
    return true;
  }
  const { connectSql, applySqlSchema } = await import("./database-sql.mjs");
  const env = readProjectEnv();
  const url = env.MOON_DATABASE_URL || env.SUPABASE_DB_URL;
  if (!url) throw new Error("Credencial administrativa ausente. Execute moon db .");
  const connection = await connectSql(provider, url);
  try {
    const report = await applySqlSchema(connection, provider, schema);
    writeFileSync(resolve(projectDir, "moon/database-report.json"), JSON.stringify(report, null, 2) + "\n");
    return true;
  } finally { await connection.close(); }
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
  const ignored = new Set(["node_modules", "dist", ".git", ".moon", ".next", "build"]);
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
  const missing = selected.fields.filter(([key]) => provider === "firebase" ? ["MOON_FIREBASE_API_KEY", "MOON_FIREBASE_PROJECT_ID"].includes(key) : true).filter(([key]) => !values[key]).map(([key]) => key);
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
    const reportPath = resolve(projectDir, "moon/database-report.json");
    if (!existsSync(reportPath)) return { ok: false, message: "Execute moon db . para criar/verificar o Firestore." };
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const { discoverSchema, schemaHash } = await import("./database-schema.mjs");
    const schema = discoverSchema(projectDir)?.schema;
    return { ok: Boolean(schema && report.provider === "firebase" && report.schemaHash === schemaHash(schema)), message: "Verificação administrativa registrada; o login será validado no aplicativo." };
  }

  if (provider === "sql") return { ok: false, message: "Execute moon db . e escolha um dialeto concreto." };
  const { connectSql } = await import("./database-sql.mjs");
  const connection = await connectSql(provider, values.MOON_DATABASE_URL);
  try { await connection.query("SELECT 1"); return { ok: true, message: "Autenticação SQL e consulta reais verificadas" }; }
  finally { await connection.close(); }
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
    const code = error?.cause?.code || error?.code;
    const message = code === "ENOTFOUND"
      ? "não foi possível resolver o domínio do serviço. Verifique a internet/DNS e se a URL do projeto ainda existe"
      : code === "ECONNREFUSED"
        ? "o serviço recusou a conexão. Verifique a URL, a porta e se o projeto está ativo"
        : `não foi possível conectar: ${error instanceof Error ? error.message : String(error)}${detail}`;
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
      else print("Conexão verificada. Execute moon db . para criar e validar a estrutura.");
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
  const installed = spawnSync(platformCommand, ["--version"], { cwd: projectDir, stdio: "ignore", shell: windows, timeout: 10000 });
  const executable = installed.status === 0 ? platformCommand : npxCommand;
  const commandArgs = installed.status === 0 ? args : ["--yes", "base44", ...args];
  if (installed.status !== 0) print("Preparando o CLI oficial via npm. O primeiro uso precisa baixar dependências; falhas de rede serão exibidas.");
  print(`Iniciando conector oficial: ${executable} ${commandArgs.join(" ")}`);
  const result = spawnSync(executable, commandArgs, {
    cwd: projectDir, stdio: "inherit", shell: windows,
    env: importNetworkEnv(),
  });
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

try {
if (["run", "start", "dev", "link", "init", "config", "db", "sync"].includes(command) && isMoonSdkDirectory()) {
  print("✗ Esta é a pasta do SDK Moon, não a pasta de um aplicativo.");
  print("Entre na pasta do projeto exportado e rode: moon run .");
  process.exitCode = 1;
} else if (command === "help" || command === "--help" || command === "-h") help();
else if (command === "init" || command === "config" || command === "link") await configure({ startAfter: false });
else if (command === "login") importFromPlatform(["login"]);
else if (command === "eject") importFromPlatform(["eject"]);
else if (command === "doctor") doctor();
else if (command === "inspect") {
  const { inspectProject, printInspection } = await import("./project-inspect.mjs");
  const report = inspectProject(projectDir);
  if (process.argv.includes('--json')) print(JSON.stringify(report, null, 2)); else printInspection(report, print);
  if (report.errors.length) process.exitCode = 1;
}
else if (command === "sync") {
  const { syncProject } = await import("./project-sync.mjs");
  syncProject(projectDir, subcommand, print, { refreshLocal: process.argv.includes("--refresh-local") });
}
else if (command === "db") {
  try {
    if (subcommand) {
      const { databaseMigration } = await import("./database-migrations.mjs");
      await databaseMigration(projectDir, subcommand, { apply: process.argv.includes("--apply"), env: readProjectEnv(), print });
    } else await setupDatabase();
  }
  catch (error) { print("Falha ao preparar o banco: " + error.message); process.exitCode = 1; }
}
else if (command === "test") await testConfigured();
else if (command === "build") npm("build", resolve(fileURLToPath(new URL(".", import.meta.url)), ".."));
else if (command === "dev") npm("dev");
else if (command === "start") {
  if (readConfig()) npm("dev");
  else await configure({ startAfter: true });
}
else if (command === "run") {
  const { inspectProject, printInspection } = await import("./project-inspect.mjs");
  const inspection = inspectProject(projectDir);
  printInspection(inspection, print);
  if (inspection.errors.length) throw new Error("Resolva os erros de compatibilidade acima antes de iniciar. Nenhum banco foi alterado.");
  const { validateSyncIfPresent } = await import("./project-sync.mjs");
  validateSyncIfPresent(projectDir);
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
    await runLocalProcesses();
  } else {
  if (!readConfig() || readConfig().provider !== "none" && !existsSync(resolve(projectDir, "moon/database-report.json"))) {
    await setupDatabase();
  }
  let connected = await testConfigured();
  if (!connected) print("Configuração preservada. Confira o serviço/rede e tente novamente. Para alterar a conexão, execute moon db .");
  if (connected) {
    const activeConfig = readConfig();
    writeEnvValues(withRuntimeAliases(activeConfig.provider, { ...readEnvValues(activeConfig.env || []), VITE_MOON_PROVIDER: activeConfig.provider, VITE_MOON_DEV_AUTH_BYPASS: activeConfig.provider === "none" ? "true" : "false" }));
    loadEnvFile();
    if (!(await provisionDatabase(readConfig().provider))) process.exitCode = 1;
    else {
    const aiRequired = projectUsesAi();
    if (aiRequired && process.env.MOON_AI_API_KEY) print("✓ IA detectada e já configurada; mantendo a chave existente");
    else if (aiRequired) await configureAi();
    else print("✓ Nenhum recurso de IA detectado; configuração de IA ignorada");
    await runLocalProcesses();
    }
  }
  }
}
else { print(`Comando desconhecido: ${command}`); help(); process.exitCode = 1; }
} catch (error) { console.error("Moon: " + error.message); process.exitCode = 1; }
