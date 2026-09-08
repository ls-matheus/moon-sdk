import test from "node:test";
import assert from "node:assert/strict";
import { authorizeQuery, verifyUser } from "../bin/database-api.mjs";
import { normalizeSchema } from "../bin/database-schema.mjs";
const schema = normalizeSchema({ version: 1, entities: { Note: { access: "owner", fields: { title: { type: "string", required: true }, done: { type: "boolean" } } }, Secret: { access: "private", fields: {} } } });
test("backend sempre adiciona o proprietário verificado", () => {
  const request = authorizeQuery({ table: "note", action: "select", filters: [{ field: "user_id", operator: "$eq", value: "other" }] }, schema, { id: "real-user" });
  assert.deepEqual(request.filters.at(-1), { field: "user_id", operator: "$eq", value: "real-user" });
});
test("backend recusa proprietário forjado, tipo inválido, tabela privada e escrita em massa", () => {
  const run = payload => authorizeQuery({ table: "note", filters: [], ...payload }, schema, { id: "real-user" });
  assert.throws(() => run({ action: "insert", values: { title: "x", user_id: "other" } }), /reservado/);
  assert.throws(() => run({ action: "insert", values: { title: "x", done: "false" } }), /inválido/);
  assert.throws(() => run({ action: "insert", values: {} }), /obrigatório/);
  assert.throws(() => run({ action: "delete" }), /id/);
  assert.throws(() => run({ table: "secret", action: "select" }), /indisponível/);
  assert.throws(() => run({ action: "select", select: ["password"] }), /Projeção/);
});
test("Firebase rejeita JWT sem assinatura antes de acessar a rede", async () => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = encode({ alg: "none" }) + "." + encode({ sub: "admin", aud: "project", exp: Date.now() / 1000 + 1000 }) + ".";
  await assert.rejects(verifyUser(token, { authProvider: "firebase" }, { MOON_FIREBASE_PROJECT_ID: "project" }), /inválido/);
});

test("backend autoriza select em entidade pública e recusa escrita ou projeção inválida", () => {
  const publicSchema = normalizeSchema({ version: 1, entities: { Donut: { access: "public", fields: { name: { type: "string" }, price: { type: "number" } } } } });
  const valid = authorizeQuery({ table: "donut", action: "select", filters: [{ field: "name", operator: "$eq", value: "Glazed" }], select: ["name", "price"], order: { field: "price", ascending: true } }, publicSchema, null);
  assert.equal(valid.table, "donut");
  assert.equal(valid.limit, 100);
  assert.throws(() => authorizeQuery({ table: "donut", action: "insert", values: { name: "x" } }, publicSchema, null), /apenas leitura/);
  assert.throws(() => authorizeQuery({ table: "donut", action: "select", select: ["secret_column"] }, publicSchema, null), /Projeção/);
  assert.throws(() => authorizeQuery({ table: "donut", action: "select", filters: [{ field: "invalid_field", operator: "$eq", value: 1 }] }, publicSchema, null), /Filtro/);
});

test("função só recebe privilégio explícito e proprietário nunca perde o filtro", () => {
  const privateSchema = normalizeSchema({ version: 1, entities: {
    Note: { access: "owner", fields: { title: { type: "string", required: true } } },
    Audit: { access: "private", fields: { event: { type: "string", required: true } } },
  } });
  assert.throws(() => authorizeQuery({ table: "audit", action: "select", filters: [] }, privateSchema, { id: "u" }), /indisponível/);
  const audit = authorizeQuery({ table: "audit", action: "insert", filters: [], values: { event: "ok" } }, privateSchema, { id: "u" }, { functionGrants: { Audit: ["insert"] } });
  assert.equal(audit.values[0].event, "ok");
  const note = authorizeQuery({ table: "note", action: "select", filters: [], values: null }, privateSchema, { id: "u" }, { functionGrants: { Note: ["select"] } });
  assert.deepEqual(note.filters.at(-1), { field: "user_id", operator: "$eq", value: "u" });
  assert.throws(() => authorizeQuery({ table: "note", action: "insert", filters: [], values: { title: "x", user_id: "other" } }, privateSchema, { id: "u" }, { functionGrants: { Note: ["insert"] } }), /reservado/);
});
