import test from "node:test";
import assert from "node:assert/strict";
import { planMigration, databaseMigration } from "../bin/database-migrations.mjs";
import { normalizeSchema } from "../bin/database-schema.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const before = normalizeSchema({version:1,entities:{Note:{access:"owner",fields:{title:{type:"string",required:true}}}}});
for (const provider of ["postgres","mysql","supabase"]) test(provider+": plano aditivo mantém tabelas/colunas e usa o dialeto correto",()=>{
  const next=structuredClone(before);
  next.entities.Note.fields.description={type:"string",required:false,enum:["a","b\nline"]};
  next.entities.Tag={access:"owner",fields:{name:{type:"string"}}};
  const plan=planMigration(before,next,provider);
  assert.deepEqual(plan.blocked,[]);
  assert.match(plan.statements.join("\n"),/ADD COLUMN.*description/);
  assert.match(plan.statements.join("\n"),/CREATE TABLE.*tag/);
  assert.doesNotMatch(plan.statements.join("\n"),/DROP|TRUNCATE|DELETE FROM/);
  assert.equal(plan.statements.filter(s=>s.startsWith("CREATE TABLE")).length,1);
  if(provider==="supabase") assert.match(plan.statements.join("\n"),/ENABLE ROW LEVEL SECURITY/);
});
test("mudanças destrutivas, obrigatórios e autorização exigem revisão",()=>{
  const next=structuredClone(before);
  delete next.entities.Note.fields.title;
  next.entities.Note.access="private";
  next.entities.Note.fields.other={type:"string",required:true};
  assert.ok(planMigration(before,next,"postgres").blocked.length>=3);
});
test("Firestore não finge aplicar migração SQL",()=>{
  const next=structuredClone(before); next.entities.Note.fields.description={type:"string"};
  assert.match(planMigration(before,next,"firebase").blocked.join(),/Firestore/);
});
test("aplicação exige plano prévio e rejeita proposta alterada antes de conectar",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"moon-migration-review-"));
  try {
    mkdirSync(join(directory,"moon"));
    const next=structuredClone(before); next.entities.Note.fields.description={type:"string"};
    writeFileSync(join(directory,"moon.config.json"),JSON.stringify({provider:"postgres"}));
    writeFileSync(join(directory,"moon/schema.json"),JSON.stringify(before));
    writeFileSync(join(directory,"moon/schema.proposed.json"),JSON.stringify(next));
    const options={apply:true,print(){}};
    await assert.rejects(databaseMigration(directory,"migrate",options),/plano ainda não foi revisado/);
    await databaseMigration(directory,"diff",{print(){}});
    next.entities.Note.fields.extra={type:"boolean"};
    writeFileSync(join(directory,"moon/schema.proposed.json"),JSON.stringify(next));
    await assert.rejects(databaseMigration(directory,"migrate",options),/proposta mudou/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
