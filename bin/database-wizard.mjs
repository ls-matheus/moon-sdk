import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverSchema, compileSql, compileFirestore, identifier } from "./database-schema.mjs";
import { inferApplicationSchema } from "./database-discovery.mjs";
import { connectSql, ensureDatabase, applySqlSchema } from "./database-sql.mjs";
import { provisionFirebase } from "./database-firebase.mjs";

export async function databaseWizard({ directory, ask, secret, config = {}, env = {}, saveConfig, saveEnv, print = console.log, planOnly = false }) {
  const answer = async (label, fallback = "") => (await ask(label + (fallback ? ` [${fallback}]` : ""))).trim() || fallback;
  const yes = async (label) => /^(s|sim|y|yes)$/i.test(await answer(label + " (s/N)", "n"));
  const choose = async (label, choices, fallback) => {
    while (true) {
      const value = await answer(label + " (" + choices.join("/") + ")", fallback);
      if (choices.includes(value)) return value;
      print("Escolha uma das opções mostradas.");
    }
  };
  let provider = await choose("Banco", ["supabase", "postgres", "mysql", "firebase", "sql"], config.provider === "none" ? "supabase" : config.provider || "supabase");
  if (provider === "sql") provider = await choose("Dialeto SQL (outros motores exigem um driver específico)", ["postgres", "mysql"], "postgres");
  print("Analisando a estrutura de dados do aplicativo automaticamente...");
  const discovered = discoverSchema(directory) || inferApplicationSchema(directory);
  const schema = discovered.schema;
  print("Estrutura identificada a partir de " + discovered.source);
  // Compile before writing files: unsupported features must not leave a partial plan.
  const plan = provider === "firebase" ? compileFirestore(schema) : compileSql(schema, provider).join(";\n\n") + ";\n";
  const folder = resolve(directory, "moon");
  mkdirSync(folder, { recursive: true });
  writeFileSync(resolve(folder, "schema.json"), JSON.stringify(schema, null, 2) + "\n");
  const planPath = resolve(folder, provider === "firebase" ? "firestore.rules" : `schema.${provider}.sql`);
  writeFileSync(planPath, plan);
  print("Plano salvo em " + planPath);
  print(`${Object.keys(schema.entities).length} conjunto(s) de dados preparado(s). Os detalhes técnicos estão na pasta moon.`);
  print("Dados pessoais ficam separados por usuário; estruturas marcadas como privadas permanecem bloqueadas no navegador.");
  if (planOnly) return { planned: true, provider };
  if (!await yes("Preparar o banco deste aplicativo agora?")) { print("Plano preservado; banco não alterado."); return { applied: false }; }
  let report;
  const values = { ...env };
  const authProvider = provider === "supabase" ? "supabase" : provider === "firebase" ? "firebase"
    : await choose("Autenticação dos usuários (o banco SQL permanece o escolhido)", ["supabase", "firebase"], config.authProvider || "supabase");
  values.MOON_AUTH_PROVIDER = authProvider;
  if (authProvider === "supabase") {
    values.MOON_SUPABASE_URL = await answer("URL pública do projeto Supabase Auth", env.MOON_SUPABASE_URL || "");
    values.MOON_SUPABASE_ANON_KEY = (await secret("Chave pública anon/publishable do Supabase (Enter mantém a existente)")).trim() || env.MOON_SUPABASE_ANON_KEY || "";
    if (!values.MOON_SUPABASE_URL || !values.MOON_SUPABASE_ANON_KEY) throw new Error("URL e chave pública são necessárias para o login da aplicação.");
  } else {
    values.MOON_FIREBASE_PROJECT_ID = await answer("Project ID Firebase", env.MOON_FIREBASE_PROJECT_ID || "");
    values.MOON_FIREBASE_API_KEY = (await secret("Firebase Web API key (Enter mantém a existente)")).trim() || env.MOON_FIREBASE_API_KEY || "";
    values.MOON_FIREBASE_AUTH_DOMAIN = await answer("Firebase authDomain", env.MOON_FIREBASE_AUTH_DOMAIN || values.MOON_FIREBASE_PROJECT_ID + ".firebaseapp.com");
    values.MOON_FIREBASE_APP_ID = await answer("Firebase appId", env.MOON_FIREBASE_APP_ID || "");
    if (!values.MOON_FIREBASE_PROJECT_ID || !values.MOON_FIREBASE_API_KEY) throw new Error("Project ID e API key são necessários para o login.");
  }
  if (provider === "firebase") {
    const accountPath = await answer("Caminho do JSON da conta de serviço com permissões Datastore e Firebase Rules");
    const create = await yes("Criar o Firestore (default) se ele não existir?");
    const location = create ? await answer("Região do Firestore (ex.: southamerica-east1)") : "";
    const replaceRules = await yes("Substituir as regras Firestore existentes pelas regras deste plano? Isso muda o acesso das coleções deste projeto");
    report = await provisionFirebase(schema, { project: values.MOON_FIREBASE_PROJECT_ID, accountPath, location, create, replaceRules });
  } else {
    let url = await secret("URL de conexão administrativa (Enter usa a existente ou monta por perguntas)");
    url = url.trim() || env.MOON_DATABASE_URL || env.SUPABASE_DB_URL || "";
    if (!url) {
      const host = await answer("Host", "localhost");
      const port = await answer("Porta", provider === "mysql" ? "3306" : "5432");
      const database = identifier(await answer("Nome do banco"));
      const user = await answer("Usuário");
      const password = await secret("Senha do banco");
      const ssl = await yes("Usar TLS com verificação do certificado?");
      const address = new URL(`${provider === "mysql" ? "mysql" : "postgres"}://localhost`);
      address.hostname = host; address.port = port; address.username = user; address.password = password; address.pathname = "/" + database;
      if (ssl) address.search = provider === "mysql" ? "?ssl=true" : "?sslmode=verify-full";
      url = address.href;
    }
    const create = provider !== "supabase" && await yes("Criar esse banco no servidor se não existir?");
    const adminUrl = create ? (await secret("URL administrativa de manutenção (Enter usa o mesmo servidor/usuário)")).trim() || undefined : undefined;
    await ensureDatabase(provider, url, { create, adminUrl });
    const connection = await connectSql(provider, url);
    try { report = await applySqlSchema(connection, provider, schema); } finally { await connection.close(); }
    values.MOON_DATABASE_URL = url;
  }
  // Persist only after successful provisioning. Do not expose administrative keys via VITE_*.
  const saved = Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("MOON_") || key === "SUPABASE_DB_URL"));
  saveEnv(saved);
  saveConfig({ ...config, version: 1, provider, authProvider, mode: ["mysql", "postgres"].includes(provider) ? "backend" : "frontend", env: Object.keys(saved), schema: "moon/schema.json", provisionedAt: new Date().toISOString() });
  writeFileSync(resolve(folder, "database-report.json"), JSON.stringify({ ...report, verifiedAt: new Date().toISOString() }, null, 2) + "\n");
  print("Estrutura criada/verificada e operações administrativas testadas.");
  print("Autenticação, permissões de usuários e integração do frontend precisam passar pelos testes da aplicação; não foram simuladas.");
  return report;
}
