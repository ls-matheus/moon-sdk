import test from "node:test";
import assert from "node:assert/strict";
import { connectSql, ensureDatabase, applySqlSchema } from "../bin/database-sql.mjs";
import { normalizeSchema } from "../bin/database-schema.mjs";
import { createSqlAdapter, createClient } from "../dist/index.js";

for (const provider of ["postgres", "mysql"]) {
  const url = process.env["MOON_TEST_" + provider.toUpperCase() + "_URL"];
  test(provider + ": criação, reinstalação, CRUD e rollback em servidor real", { skip: !url }, async () => {
    await ensureDatabase(provider, url, { create: true });
    const connection = await connectSql(provider, url);
    const schema = normalizeSchema({ version: 1, entities: { Note: { access: "private", fields: {
      title: { type: "string", required: true }, done: { type: "boolean" }, payload: { type: "json" }, rank: { type: "integer" },
    } } } });
    try {
      await applySqlSchema(connection, provider, schema);
      await applySqlSchema(connection, provider, schema);
      const client = createClient(createSqlAdapter(connection, provider, schema));
      const note = await client.entities.Note.create({ title: "Teste", done: true, payload: { nested: [1, 2] }, rank: 3 });
      assert.ok(note.id);
      assert.equal(note.done, true);
      assert.deepEqual(note.payload, { nested: [1, 2] });
      assert.equal((await client.entities.Note.get(note.id)).title, "Teste");
      assert.equal((await client.entities.Note.update(note.id, { title: "Atualizado" })).title, "Atualizado");
      assert.equal((await client.entities.Note.filter({ id: { $in: [note.id] } })).length, 1);
      await client.entities.Note.delete(note.id);
      await assert.rejects(client.entities.Note.get(note.id), /not found/);
      await assert.rejects(client.entities.Note.create({ payload: {} }));
      const changed = structuredClone(schema); changed.entities.Note.fields.other = { type: "string" };
      await assert.rejects(applySqlSchema(connection, provider, changed), /migração/);
    } finally { await connection.close(); }
  });
}
