import test from "node:test";
import assert from "node:assert/strict";
import { compileFunction, runFunctionSource } from "../bin/function-runtime.mjs";
import { createFunctionInvoker, ensureSession } from "../bin/client-bridge.mjs";
import { installLoginBootstrap } from "../bin/runtime-auth.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = `import {createClientFromRequest} from 'npm:@base44/sdk@0.8.44';
export default async function(req) {
  const base44=createClientFromRequest(req);
  const {message}=await req.json();
  const notes=await base44.asServiceRole.entities.Note.list('-note_date',100);
  const reply=await base44.asServiceRole.integrations.Core.InvokeLLM({prompt:notes.map(n=>n.title).join(',')+' '+message});
  return Response.json({reply});
}`;

test("função exportada mantém handler/prompt e encaminha dados pelo adaptador", async()=>{
  const calls=[];
  const result=await runFunctionSource(source,{message:'hoje?'},{id:'owner-a'},async(method,args)=>{
    calls.push({method,args});
    if(method==='entity') return [{title:'Somente minha nota'}];
    assert.equal(args.prompt,'Somente minha nota hoje?'); return 'Resposta de teste';
  });
  assert.deepEqual(result,{status:200,data:{reply:'Resposta de teste'}});
  assert.deepEqual(calls[0],{method:'entity',args:{entity:'Note',method:'list',args:['-note_date',100]}});
});
test("worker não recebe credenciais do ambiente pai e interrompe loop",async()=>{
  const envSource=`import {createClientFromRequest} from '@base44/sdk'; export default async function(){return Response.json({process:typeof process});}`;
  const result=await runFunctionSource(envSource,{}, {id:'a'},()=>assert.fail());
  assert.equal(result.data.process,'undefined');
  await assert.rejects(runFunctionSource(`import {createClientFromRequest} from '@base44/sdk';export default async function(){while(true){}}`,{}, {id:'a'},()=>{},200),/tempo limite/);
});
test("não executa dependências ou imports dinâmicos não suportados",()=>{
  assert.throws(()=>compileFunction(`import fs from 'node:fs';export default ()=>{};`),/dependências/);
  assert.throws(()=>compileFunction(`import {createClientFromRequest} from '@base44/sdk';export default async()=>import('node:fs');`),/dinâmicos/);
});
test("functions.invoke envia token e preserva response.data; recusa sessão ausente",async()=>{
  const invoke=createFunctionInvoker({getAccessToken:async()=>'USER_TOKEN'},async(url,options)=>{
    assert.equal(url,'/api/functions/assistente_notas');
    assert.equal(options.headers.Authorization,'Bearer USER_TOKEN');
    return Response.json({reply:'ok'});
  });
  assert.deepEqual(await invoke('assistente_notas',{message:'x'}),{status:200,data:{reply:'ok'}});
  await assert.rejects(createFunctionInvoker({getAccessToken:async()=>undefined},()=>assert.fail())('test'),/Entre na sua conta/);
  const fail=createFunctionInvoker({getAccessToken:async()=>'token'},async()=>Response.json({error:'Cota excedida'},{status:429}));
  await assert.rejects(fail('test'),error=>error.response.data.error==='Cota excedida');
});
test("sessão existente não exige login novamente",async()=>{
  await ensureSession({isAuthenticated:async()=>true},null);
});
test("bootstrap exige sessão antes de importar app e usa auth do provedor",()=>{
  const directory=mkdtempSync(join(tmpdir(),'moon-login-test-'));
  try {
    mkdirSync(join(directory,'src/lib'),{recursive:true});
    writeFileSync(join(directory,'index.html'),'<html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>');
    writeFileSync(join(directory,'src/lib/AuthContext.jsx'),'if (appParams.token) {}');
    installLoginBootstrap(directory,join(directory,'src/api/base44Client.js'),'supabase');
    assert.match(readFileSync(join(directory,'index.html'),'utf8'),/moon-bootstrap/);
    assert.match(readFileSync(join(directory,'src/moon-bootstrap.mjs'),'utf8'),/ensureSession\(moonAuth\)\.then\(\(\) => import/);
    assert.match(readFileSync(join(directory,'src/lib/AuthContext.jsx'),'utf8'),/await base44.auth.isAuthenticated/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
