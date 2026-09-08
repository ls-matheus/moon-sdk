import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeSchema, schemaHash, compileSql, tableName, identifier } from "./database-schema.mjs";
import { connectSql, applySqlSchema } from "./database-sql.mjs";
import { validateSyncIfPresent, acceptMigratedSchema } from "./project-sync.mjs";

export function planMigration(before, after, provider) {
  const previous = normalizeSchema(before), next = normalizeSchema(after);
  const blocked = [], changes = [], statements = [];
  const quote = name => (provider === "mysql" ? "`" : '"') + identifier(name) + (provider === "mysql" ? "`" : '"');
  for (const [entity, def] of Object.entries(previous.entities)) {
    const target = next.entities[entity];
    if (!target) { blocked.push(`Remoção de ${entity}`); continue; }
    if (def.access !== target.access) {
      if (provider === "supabase" && def.access === "owner" && target.access === "public") {
        const table = quote(tableName(entity));
        changes.push(`Tornar ${entity} público somente para leitura`);
        statements.push(`DROP POLICY IF EXISTS moon_owner ON ${table}`);
        statements.push(`CREATE POLICY moon_public_read ON ${table} FOR SELECT TO anon, authenticated USING (true)`);
        statements.push(`GRANT SELECT ON ${table} TO anon, authenticated`);
        statements.push(`REVOKE INSERT, UPDATE, DELETE ON ${table} FROM anon, authenticated`);
      } else blocked.push(`Mudança de acesso: ${entity}`);
    }
    for (const [field, definition] of Object.entries(def.fields)) {
      if (!target.fields[field]) blocked.push(`Remoção de ${entity}.${field}`);
      else if (!isDeepStrictEqual(definition, target.fields[field])) blocked.push(`Mudança de tipo/regra: ${entity}.${field}`);
    }
    for (const [field, definition] of Object.entries(target.fields)) if (!def.fields[field]) {
      changes.push(`Adicionar ${entity}.${field}`);
      if (definition.required || definition.references) { blocked.push(`Novo campo obrigatório/relacionamento exige revisão e preenchimento dos dados existentes: ${entity}.${field}`); continue; }
      if (provider !== "firebase") {
        // Compile the exact column with the same dialect compiler used for initial provisioning.
        const temporary = { version: 1, entities: { Migration: { access: "private", fields: { [field]: definition } } } };
        const sql = compileSql(temporary, provider)[0];
        const start = sql.indexOf("  " + quote(field) + " ");
        const end = sql.lastIndexOf("\n)");
        if (start < 0 || end < start) throw new Error("Falha ao compilar a coluna da migração.");
        statements.push(`ALTER TABLE ${quote(tableName(entity))} ADD COLUMN ${sql.slice(start, end).trim()}`);
      }
    }
  }
  const newEntities = Object.keys(next.entities).filter(entity => !previous.entities[entity]);
  for (const entity of newEntities) changes.push(`Criar ${entity}`);
  if (provider !== "firebase") {
    const all = compileSql(next, provider);
    // All CREATEs before foreign keys/policies, matching the full-schema compiler.
    statements.push(...all.filter(sql => newEntities.some(entity => {
      const table = quote(tableName(entity));
      return sql.startsWith(`CREATE TABLE ${table} (`) || sql.startsWith(`ALTER TABLE ${table} `) || sql.startsWith(`CREATE POLICY moon_owner ON ${table} `) || sql.startsWith(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} `);
    })));
  } else if (changes.length) blocked.push("Migração Firestore exige revisão/publicação explícita das regras; não é aplicada por este comando.");
  return { version: 1, provider, from: schemaHash(previous), to: schemaHash(next), changes, blocked, statements, schema: next };
}

export async function migrateSql(connection, provider, previous, next) {
  const plan = planMigration(previous, next, provider);
  if (plan.blocked.length) throw new Error("Migração bloqueada: " + plan.blocked.join("; "));
  if (!plan.changes.length) return { provider, schemaHash: plan.to, checked: ["no-changes"] };
  // Validate the recorded starting point and actual columns/privileges first.
  await applySqlSchema(connection, provider, previous);
  const mysql = provider === "mysql";
  let locked = false, transaction = false;
  try {
    if (mysql) {
      const lock = await connection.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':moon-schema'), 10) AS acquired");
      if (Number(lock.rows[0]?.acquired) !== 1) throw new Error("Outra alteração do banco está em andamento.");
    } else await connection.query("SELECT pg_advisory_lock(1836019566)");
    locked = true;
    if (!mysql) { await connection.query("BEGIN"); transaction = true; }
    const recorded = await connection.query("SELECT hash FROM _moon_schema WHERE id = 1");
    if (recorded.rows[0]?.hash !== plan.from) throw new Error("O banco mudou desde a revisão; gere outro plano.");
    for (const sql of plan.statements) await connection.query(sql);
    const q = name => (mysql ? "`" : '"') + identifier(name) + (mysql ? "`" : '"');
    for (const [entity, definition] of Object.entries(plan.schema.entities))
      await connection.query(`SELECT ${Object.keys(definition.fields).map(q).join(", ")} FROM ${q(tableName(entity))} WHERE 1 = 0`);
    await connection.query(`UPDATE _moon_schema SET hash = ${mysql ? "?" : "$1"} WHERE id = 1`, [plan.to]);
    if (transaction) { await connection.query("COMMIT"); transaction = false; }
    return { provider, schemaHash: plan.to, checked: ["starting-schema-crud", "migration", "columns-readable"], authentication: "not-tested" };
  } catch (error) {
    if (transaction) await connection.query("ROLLBACK").catch(() => {});
    if (mysql) error.message += " MySQL não reverte DDL: uma falha parcial requer revisão antes de repetir. Não altere o schema local para esconder a divergência.";
    throw error;
  } finally {
    if (locked) await connection.query(mysql ? "SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':moon-schema'))" : "SELECT pg_advisory_unlock(1836019566)").catch(() => {});
  }
}

export async function databaseMigration(directory, action, { apply = false, env = {}, print = console.log } = {}) {
  validateSyncIfPresent(directory);
  const config = JSON.parse(readFileSync(resolve(directory, "moon.config.json")));
  const before = JSON.parse(readFileSync(resolve(directory, "moon/schema.json")));
  const proposedPath = resolve(directory, "moon/schema.proposed.json");
  if (!existsSync(proposedPath)) throw new Error("Nenhuma proposta de estrutura encontrada. A IA/desenvolvedor deve propor as alterações em moon/schema.proposed.json, preservando moon/schema.json. O usuário não precisa desenhar tabelas.");
  const after = JSON.parse(readFileSync(proposedPath));
  const plan = planMigration(before, after, config.provider);
  print(plan.changes.length ? plan.changes.join("\n") : "Nenhuma mudança de estrutura.");
  if (plan.blocked.length) { print("Revisão técnica necessária:\n" + plan.blocked.join("\n")); if (action === "migrate") throw new Error("Migração incompatível bloqueada; banco preservado."); return plan; }
  const reviewDirectory = resolve(directory, ".moon");
  if (existsSync(reviewDirectory) && lstatSync(reviewDirectory).isSymbolicLink()) throw new Error(".moon não pode ser um link simbólico.");
  const reviewPath = resolve(reviewDirectory, "migration-plan.json");
  if (existsSync(reviewPath) && lstatSync(reviewPath).isSymbolicLink()) throw new Error("O plano local não pode ser um link simbólico.");
  const identity = { provider: plan.provider, from: plan.from, to: plan.to, statements: plan.statements };
  if (action !== "migrate" || !apply) {
    mkdirSync(reviewDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(reviewPath, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
    print("Nada aplicado. Após revisar o plano e ter backup do banco, use moon db migrate --apply."); return plan;
  }
  if (!plan.changes.length) return plan;
  if (!existsSync(reviewPath) || !isDeepStrictEqual(JSON.parse(readFileSync(reviewPath)), identity))
    throw new Error("O plano ainda não foi revisado ou a proposta mudou. Execute moon db diff novamente antes de aplicar.");
  if (!["postgres", "mysql", "supabase"].includes(config.provider)) throw new Error("Migração automática disponível apenas para PostgreSQL, MySQL e Supabase.");
  const url = env.MOON_DATABASE_URL || env.SUPABASE_DB_URL;
  if (!url) throw new Error("Conexão administrativa local ausente; execute moon db .");
  const connection = await connectSql(config.provider, url);
  let report;
  try { report = await migrateSql(connection, config.provider, before, after); } finally { await connection.close(); }
  // Keep a local recovery record before changing the accepted shared contract.
  writeFileSync(resolve(directory, "moon/database-report.json"), JSON.stringify({ ...report, previousSchema: normalizeSchema(before), appliedSchema: plan.schema, verifiedAt: new Date().toISOString() }, null, 2) + "\n");
  writeFileSync(resolve(directory, "moon/schema.json"), JSON.stringify(plan.schema, null, 2) + "\n");
  acceptMigratedSchema(directory, plan.schema);
  print("Migração aditiva aplicada. Dados existentes preservados; revise e faça commit do schema/contrato atualizado. Login e funcionalidades do app ainda precisam de testes reais.");
  return report;
}
