import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSchema, compileSql, compileFirestore, schemaHash } from "../bin/database-schema.mjs";
import { databaseWizard } from "../bin/database-wizard.mjs";
import { applySqlSchema } from "../bin/database-sql.mjs";
import { createSqlAdapter, createClient } from "../dist/index.js";

export const fixture = { version: 1, entities: { Note: { access: "owner", fields: {
  title: { type: "string", required: true }, done: { type: "boolean" }, payload: { type: "json" }, rank: { type: "integer" },
} } } };

test("schema comum é determinístico e rejeita dados inválidos", () => {
  const schema = normalizeSchema(fixture);
  assert.equal(schemaHash(schema), schemaHash(fixture));
  assert.equal(schema.entities.Note.fields.id.type, "uuid");
  assert.throws(() => normalizeSchema({ version: 1, entities: { 'bad; DROP TABLE users': fixture.entities.Note } }));
  assert.throws(() => normalizeSchema({ version: 1, entities: { Note: { access: "public", fields: {} } } }));
  assert.throws(() => normalizeSchema({ version: 1, entities: { Note: { access: "private", fields: { amount: { type: "money" } } } } }));
});
test("PostgreSQL puro não recebe auth do Supabase; MySQL não recebe sintaxe PG", () => {
  const postgres = compileSql(fixture, "postgres").join("\n");
  assert.doesNotMatch(postgres, /auth\.|policy/i);
  assert.match(postgres, /jsonb/);
  const mysql = compileSql(fixture, "mysql").join("\n");
  assert.doesNotMatch(mysql, /timestamptz|jsonb|gen_random_uuid|auth\./);
  assert.match(mysql, /ENGINE=InnoDB/);
  assert.match(compileSql(fixture, "supabase").join("\n"), /WITH CHECK \(auth.uid\(\)::text = user_id\)/);
  assert.throws(() => compileSql(fixture, "sql"));
});
test("regras Firestore impedem mudança de proprietário e validam campos", () => {
  const rules = compileFirestore(fixture);
  assert.match(rules, /request.resource.data.user_id == request.auth.uid/);
  assert.match(rules, /resource.data.user_id == request.auth.uid/);
  assert.match(rules, /hasOnly/);
  assert.match(rules, /hasAll/);
});
test("assistente gera plano apenas com respostas, sem credenciais nem acesso ao banco", async () => {
  const directory = mkdtempSync(join(tmpdir(), "moon-wizard-"));
  try {
    const responses = ["sql", "mysql", "Note", "owner", "title", "string", "s", ""];
    const result = await databaseWizard({
      directory, ask: async () => { assert.ok(responses.length); return responses.shift(); },
      secret: async () => { throw new Error("Não deve pedir credenciais"); },
      saveConfig: () => assert.fail("Não deve configurar conexão em --plan"),
      saveEnv: () => assert.fail("Não deve salvar segredos em --plan"),
      planOnly: true, print() {},
    });
    assert.equal(result.provider, "mysql");
    assert.equal(JSON.parse(readFileSync(join(directory, "moon/schema.json"))).entities.Note.fields.title.required, true);
    assert.match(readFileSync(join(directory, "moon/schema.mysql.sql"), "utf8"), /CREATE TABLE/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("filtros SQL parametrizam listas e tratam NULL sem parâmetros inválidos", async () => {
  const calls = [];
  const adapter = createSqlAdapter({ async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: [] }; } });
  await adapter.from("Note").select().where("title", "$in", ["x", "y"]).eq("done", null);
  assert.match(calls[0].sql, /IN \(\$1, \$2\).*IS NULL/);
  assert.deepEqual(calls[0].parameters, ["x", "y"]);
  const result = await adapter.from("Note").update({ title: "oops" });
  assert.match(result.error.message, /filtro/);
  assert.equal(calls.length, 1);
});
test("MySQL usa LIKE compatível e bloqueia gravações sem transação", async () => {
  const calls = [];
  const adapter = createSqlAdapter({ async query(sql, parameters) { calls.push({ sql, parameters }); return { rows: [] }; } }, "mysql");
  await adapter.from("Note").select().where("title", "$ilike", "%x%");
  assert.match(calls[0].sql, /LOWER\(.*\) LIKE LOWER\(\?\)/);
  const result = await adapter.from("Note").insert({ title: "x" });
  assert.match(result.error.message, /transaction/);
});
test("falha SQL causa rollback e libera trava", async () => {
  const calls = [];
  const connection = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith('CREATE TABLE "note"')) throw new Error("sem permissão");
    return { rows: [] };
  } };
  await assert.rejects(applySqlSchema(connection, "postgres", fixture), /sem permissão/);
  assert.ok(calls.includes("ROLLBACK"));
  assert.ok(calls.some(sql => sql.includes("pg_advisory_unlock")));
});
