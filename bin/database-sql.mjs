import { randomUUID } from "node:crypto";
import { compileSql, normalizeSchema, schemaHash, identifier, tableName } from "./database-schema.mjs";

export async function connectSql(provider, url) {
  const parsed = new URL(url);
  const mysql = provider === "mysql";
  if (!(mysql ? ["mysql:"] : ["postgres:", "postgresql:"]).includes(parsed.protocol))
    throw new Error("A URL não corresponde ao dialeto escolhido.");
  if (!parsed.pathname.slice(1)) throw new Error("Informe o nome do banco na URL.");
  if (mysql) {
    const { createConnection } = await import("mysql2/promise");
    const connection = await createConnection({
      host: parsed.hostname, port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password),
      database: decodeURIComponent(parsed.pathname.slice(1)), connectTimeout: 10000,
      ...(parsed.searchParams.get("ssl") === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
      multipleStatements: false, dateStrings: true,
    });
    await connection.query("SET time_zone = '+00:00'");
    const executor = {
      async query(sql, params = []) { const [rows] = await connection.execute(sql, params); return { rows: Array.isArray(rows) ? rows : [], affected: rows.affectedRows }; },
      close: () => connection.end(),
      async transaction(run) {
        await connection.beginTransaction();
        try { const result = await run(executor); await connection.commit(); return result; }
        catch (error) { await connection.rollback(); throw error; }
      },
    };
    return executor;
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
  const executor = {
    query: (sql, params = []) => client.query(sql, params), close: () => client.end(),
    async transaction(run) {
      await client.query("BEGIN");
      try { const result = await run(executor); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    },
  };
  return executor;
}
export async function ensureDatabase(provider, url, { create = false, adminUrl } = {}) {
  try { const connection = await connectSql(provider, url); await connection.close(); return; }
  catch (error) {
    if (!create || !["3D000", "ER_BAD_DB_ERROR"].includes(error.code)) throw error;
    if (provider === "supabase") throw new Error("O projeto Supabase precisa existir. Informe sua conexão PostgreSQL administrativa.");
  }
  const target = new URL(url);
  const name = identifier(decodeURIComponent(target.pathname.slice(1)));
  if (!adminUrl) {
    const maintenance = new URL(url);
    maintenance.pathname = provider === "mysql" ? "/mysql" : "/postgres";
    adminUrl = maintenance.href;
  }
  const admin = await connectSql(provider, adminUrl);
  try {
    await admin.query(provider === "mysql"
      ? "CREATE DATABASE `" + name + "` CHARACTER SET utf8mb4"
      : 'CREATE DATABASE "' + name + '"');
  } finally { await admin.close(); }
}

// Only create new tables or revalidate a previously recorded schema.
// Never silently rewrite existing user tables or drop data.
export async function applySqlSchema(connection, provider, input) {
  const schema = normalizeSchema(input);
  const mysql = provider === "mysql";
  const hash = schemaHash(schema);
  const placeholder = mysql ? "?" : "$1";
  let locked = false, transaction = false;
  try {
    if (mysql) {
      const result = await connection.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':moon-schema'), 10) AS acquired");
      if (Number(result.rows[0]?.acquired) !== 1) throw new Error("Outra preparação do banco está em andamento.");
    } else await connection.query("SELECT pg_advisory_lock(1836019566)");
    locked = true;
    if (!mysql) { await connection.query("BEGIN"); transaction = true; }
    await connection.query("CREATE TABLE IF NOT EXISTS _moon_schema (id integer PRIMARY KEY, hash varchar(64) NOT NULL)");
    const recorded = await connection.query("SELECT hash FROM _moon_schema WHERE id = 1");
    if (recorded.rows.length && recorded.rows[0].hash !== hash)
      throw new Error("O schema mudou. Uma migração revisada é necessária; nenhuma tabela existente será alterada automaticamente.");
    const tables = Object.keys(schema.entities).map(tableName);
    const existing = await connection.query(mysql
      ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()"
      : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()");
    const present = new Set(existing.rows.map(row => row.name));
    if (!recorded.rows.length) {
      const collisions = tables.filter(name => present.has(name));
      if (collisions.length) throw new Error("Tabelas já existentes sem registro Moon: " + collisions.join(", ") + ". Revise/importe o schema antes de continuar.");
      for (const statement of compileSql(schema, provider)) await connection.query(statement);
      await connection.query(`INSERT INTO _moon_schema (id, hash) VALUES (1, ${placeholder})`, [hash]);
    }
    for (const [entity, definition] of Object.entries(schema.entities)) {
      const metadata = await connection.query(mysql
        ? "SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?"
        : "SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [tableName(entity)]);
      const expected = mysql
        ? { string: "text", integer: "int", number: "double", boolean: "tinyint", json: "json", datetime: "datetime", uuid: "char" }
        : { string: "text", integer: "integer", number: "double precision", boolean: "boolean", json: "jsonb", datetime: "timestamp with time zone", uuid: "uuid" };
      for (const [name, field] of Object.entries(definition.fields)) {
        const column = metadata.rows.find(column => column.name === name);
        if (!column || column.type !== expected[field.type] || column.nullable !== (field.required ? "NO" : "YES"))
          throw new Error(`Estrutura divergente em ${entity}.${name}; revise tipo e nulabilidade.`);
      }
      const quote = mysql ? "`" : '"';
      const columns = Object.keys(definition.fields).map(key => quote + identifier(key) + quote).join(", ");
      await connection.query(`SELECT ${columns} FROM ${quote}${tableName(entity)}${quote} WHERE 1 = 0`);
    }
    // Verify actual write/read/update/delete privileges without leaving test records.
    await connection.query(mysql
      ? "CREATE TEMPORARY TABLE _moon_probe (id varchar(36) PRIMARY KEY, value integer)"
      : "CREATE TEMP TABLE _moon_probe (id varchar(36) PRIMARY KEY, value integer) ON COMMIT DROP");
    if (mysql) { await connection.query("START TRANSACTION"); transaction = true; }
    const id = randomUUID();
    await connection.query(mysql ? "INSERT INTO _moon_probe VALUES (?, ?)" : "INSERT INTO _moon_probe VALUES ($1, $2)", [id, 1]);
    await connection.query(`UPDATE _moon_probe SET value = 2 WHERE id = ${placeholder}`, [id]);
    const result = await connection.query(`SELECT value FROM _moon_probe WHERE id = ${placeholder}`, [id]);
    if (Number(result.rows[0]?.value) !== 2) throw new Error("Teste de leitura/escrita inconsistente.");
    await connection.query(`DELETE FROM _moon_probe WHERE id = ${placeholder}`, [id]);
    const removed = await connection.query(`SELECT value FROM _moon_probe WHERE id = ${placeholder}`, [id]);
    if (removed.rows.length) throw new Error("Teste de exclusão inconsistente.");
    await connection.query("COMMIT"); transaction = false;
    return { provider, schemaHash: hash, tables, checked: ["schema", "insert", "select", "update", "delete"], authentication: "not-tested" };
  } catch (error) {
    if (transaction) await connection.query("ROLLBACK").catch(() => {});
    if (mysql) error.message += " MySQL confirma DDL automaticamente: em falha parcial, revise as tabelas criadas antes de repetir.";
    throw error;
  } finally {
    if (mysql) await connection.query("DROP TEMPORARY TABLE IF EXISTS _moon_probe").catch(() => {});
    if (locked) await connection.query(mysql ? "SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':moon-schema'))" : "SELECT pg_advisory_unlock(1836019566)").catch(() => {});
  }
}
