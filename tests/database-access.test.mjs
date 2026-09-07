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
