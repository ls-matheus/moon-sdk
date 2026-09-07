import test from "node:test";
import assert from "node:assert/strict";
import { connectSql, ensureDatabase, applySqlSchema } from "../bin/database-sql.mjs";
import { migrateSql } from "../bin/database-migrations.mjs";
import { normalizeSchema, schemaHash } from "../bin/database-schema.mjs";
import { createClient, createSqlAdapter } from "../dist/index.js";

for (const provider of ["postgres", "mysql"]) {
  const url = process.env["MOON_TEST_" + provider.toUpperCase() + "_URL"];
  test(provider + ": migração real mantém registros existentes e cria entidades", {skip:!url}, async () => {
    const address = new URL(url); address.pathname = "/moon_migration_ci";
    await ensureDatabase(provider,address.href,{create:true});
    const connection=await connectSql(provider,address.href);
    const before=normalizeSchema({version:1,entities:{Note:{access:"private",fields:{title:{type:"string",required:true}}}}});
    const after=structuredClone(before);
    after.entities.Note.fields.description={type:"string"};
    after.entities.Tag={access:"private",fields:{name:{type:"string",required:true}}};
    try {
      await applySqlSchema(connection,provider,before);
      const client=createClient(createSqlAdapter(connection,provider,before));
      const row=await client.entities.Note.create({title:"Não perder"});
      const report=await migrateSql(connection,provider,before,after);
      assert.equal(report.schemaHash,schemaHash(after));
      await applySqlSchema(connection,provider,after);
      const migrated=createClient(createSqlAdapter(connection,provider,normalizeSchema(after)));
      assert.equal((await migrated.entities.Note.get(row.id)).title,"Não perder");
      assert.equal((await migrated.entities.Note.update(row.id,{description:"Novo campo"})).description,"Novo campo");
      const tag=await migrated.entities.Tag.create({name:"Nova tabela"});
      assert.equal((await migrated.entities.Tag.get(tag.id)).name,"Nova tabela");
      await migrated.entities.Tag.delete(tag.id);
      await migrated.entities.Note.delete(row.id);
      await assert.rejects(migrateSql(connection,provider,after,{version:1,entities:{Tag:after.entities.Tag}}),/bloqueada/);
    } finally {await connection.close();}
  });
}
