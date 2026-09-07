import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { connectSql, ensureDatabase, applySqlSchema } from "../bin/database-sql.mjs";
import { normalizeSchema } from "../bin/database-schema.mjs";
import { createClient, createSqlAdapter } from "../dist/index.js";
import { invokeLocalFunction } from "../bin/function-runtime.mjs";

for (const provider of ["supabase", "mysql"]) {
  const dialect=provider==='supabase'?'postgres':'mysql';
  const url=process.env['MOON_TEST_'+dialect.toUpperCase()+'_URL'];
  test(provider+": função exportada lê somente as notas do usuário em banco real",{skip:!url},async()=>{
    const directory=mkdtempSync(join(tmpdir(),'moon-function-integration-'));
    const userA='00000000-0000-4000-8000-000000000001',userB='00000000-0000-4000-8000-000000000002';
    const auth=createServer((req,res)=>{res.setHeader('Content-Type','application/json'); if(req.headers.authorization==='Bearer user-a-token')res.end(JSON.stringify({id:userA}));else{res.statusCode=401;res.end('{}');}});
    auth.listen(0,'127.0.0.1'); await once(auth,'listening');
    let connection;
    try {
      const address=new URL(url);address.pathname='/moon_function_ci';
      await ensureDatabase(dialect,address.href,{create:true});connection=await connectSql(dialect,address.href);
      const schema=normalizeSchema({version:1,entities:{Note:{access:'owner',fields:{title:{type:'string'}}}}});
      await applySqlSchema(connection,dialect,schema);
      const client=createClient(createSqlAdapter(connection,dialect,schema));
      const a=await client.entities.Note.create({title:'Nota privada A',user_id:userA});
      const b=await client.entities.Note.create({title:'Nota privada B',user_id:userB});
      mkdirSync(join(directory,'base44/functions/notes'),{recursive:true});mkdirSync(join(directory,'moon'));
      writeFileSync(join(directory,'moon/schema.json'),JSON.stringify(schema));
      writeFileSync(join(directory,'base44/functions/notes/entry.ts'),`import {createClientFromRequest} from 'npm:@base44/sdk@0.8.44';export default async function(req){const b=createClientFromRequest(req);const notes=await b.asServiceRole.entities.Note.list();const reply=await b.asServiceRole.integrations.Core.InvokeLLM({prompt:notes.map(n=>n.title).join(',')});return Response.json({reply});}`);
      const env={MOON_DATABASE_URL:address.href,MOON_SUPABASE_URL:'http://127.0.0.1:'+auth.address().port,MOON_SUPABASE_ANON_KEY:'public-test-key'};
      const result=await invokeLocalFunction('notes',{},'user-a-token',{provider,authProvider:'supabase'},env,directory,async messages=>{
        assert.match(messages[0].content,/Nota privada A/);assert.doesNotMatch(messages[0].content,/Nota privada B/);return 'Resposta isolada';
      });
      assert.deepEqual(result,{status:200,data:{reply:'Resposta isolada'}});
      await assert.rejects(invokeLocalFunction('notes',{},'invalid',{provider,authProvider:'supabase'},env,directory,()=>assert.fail()),/inválida/);
      await client.entities.Note.delete(a.id);await client.entities.Note.delete(b.id);
    } finally {if(connection)await connection.close();await new Promise(resolve=>auth.close(resolve));rmSync(directory,{recursive:true,force:true});}
  });
}
