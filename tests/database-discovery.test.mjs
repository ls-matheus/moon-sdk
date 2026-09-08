import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferApplicationSchema } from "../bin/database-discovery.mjs";
import { discoverSchema, compileSql, compileFirestore } from "../bin/database-schema.mjs";
import { databaseWizard } from "../bin/database-wizard.mjs";

async function project(files, run) {
  const directory = mkdtempSync(join(tmpdir(), "moon-discovery-"));
  try {
    for (const [name, code] of Object.entries(files)) {
      const path = join(directory, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, code);
    }
    return await run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("analisa JS sem executá-lo; resolve variáveis, spreads e atualizações", () => project({
  "app.js": `throw new Error('never execute');
    const initial = {title: '', done: false, amount: 0, tags: [], metadata: {color:'red'}};
    const data = {...initial, description: 'note'};
    moon.entities.Note.create(data);
    moon.entities.Note.update('id', {amount: 1.5});`,
}, directory => {
  const { schema } = inferApplicationSchema(directory);
  const fields = schema.entities.Note.fields;
  assert.equal(fields.title.type, "string");
  assert.equal(fields.done.type, "boolean");
  assert.equal(fields.amount.type, "number");
  assert.equal(fields.tags.type, "json");
  assert.equal(fields.metadata.type, "json");
  assert.equal(fields.description.type, "string");
  assert.equal(fields.title.required, false);
  assert.equal(schema.entities.Note.access, "owner");
  for (const provider of ["postgres", "mysql", "supabase"]) assert.match(compileSql(schema, provider).join("\n"), /CREATE TABLE/);
  assert.match(compileFirestore(schema), /request.auth.uid/);
}));

test("resolve interface importada, parâmetros tipados e opcionais", () => project({
  "types.ts": 'export interface Form {title: string; done?: boolean; amount: number; tags: string[]}',
  "app.ts": `import type {Form} from './types.js';
    function save(form: Form) { moon.entities.Note.create({...form, description: 'ok'}); }`,
}, directory => {
  const fields = inferApplicationSchema(directory).schema.entities.Note.fields;
  assert.equal(fields.title.type, "string");
  assert.equal(fields.done.type, "boolean");
  assert.equal(fields.tags.type, "json");
}));

test("bulkCreate literal combina campos sem impor obrigatoriedade falsa", () => project({
  "app.ts": `moon.entities.Note.bulkCreate([{title:'a'}, {title:'b', done:true}]);`,
}, directory => assert.equal(inferApplicationSchema(directory).schema.entities.Note.fields.done.type, "boolean")));

for (const [name, source, message] of [
  ["payload dinâmico", "function save(data) { moon.entities.Note.create(data) }", /campos enviados/],
  ["campo dinâmico", "function save(value) { moon.entities.Note.create({title:value}) }", /Note.title/],
  ["tipos conflitantes", "moon.entities.Note.create({title:'x'});moon.entities.Note.update('id',{title:4})", /incompatíveis/],
  ["entidade somente lida", "moon.entities.Note.list()", /nenhuma estrutura/],
  ["spread desconhecido", "function save(data) {moon.entities.Note.create({...data,title:'x'})}", /campos enviados/],
  ["datas não serializadas", "moon.entities.Note.create({date:new Date()})", /incompatível/],
  ["referência indireta", "const Notes = moon.entities.Note; Notes.create({title:'x'})", /referência indireta/],
  ["acesso por colchetes", "moon.entities['Note'].create({title:'x'})", /entities\[\.\.\.\]/],
]) test(`bloqueia ${name} com localização e sem esquema parcial`, () => project({ "app.ts": source }, async directory => {
  assert.throws(() => inferApplicationSchema(directory), message);
  await assert.rejects(databaseWizard({ directory, ask: async () => "postgres", secret: async () => assert.fail("sem credenciais"), print() {} }), message);
  assert.equal(existsSync(join(directory, "moon/schema.json")), false);
}));

test("pasta vazia e comentários não inventam entidades", () => project({
  "app.ts": "// moon.entities.Note.create({title:'fake'})",
}, directory => assert.throws(() => inferApplicationSchema(directory), /código completo/)));

test("importação preserva obrigatórios e fecha acesso quando há regras personalizadas", () => project({
  "base44/entities/Note.json": JSON.stringify({name:"Note", properties:{title:{type:"string"}}, required:["title"]}),
  "base44/entities/Admin.json": JSON.stringify({name:"Admin", properties:{flag:{type:"boolean"}}, rls:{read:true}}),
  "base44/entities/Secret.json": JSON.stringify({name:"Secret", properties:{flag:{type:"boolean"}}, rls:false}),
}, directory => {
  const {schema} = discoverSchema(directory);
  assert.equal(schema.entities.Note.fields.title.required, true);
  assert.equal(schema.entities.Note.access, "owner");
  assert.equal(schema.entities.Admin.access, "private");
  assert.equal(schema.entities.Secret.access, "private");
}));

test("importação descobre entidades públicas por access ou permissões de leitura", () => project({
  "base44/entities/Catalog.json": JSON.stringify({name:"Catalog", properties:{title:{type:"string"}}, access:"public"}),
  "base44/entities/Article.json": JSON.stringify({name:"Article", properties:{slug:{type:"string"}}, permissions:{read:"public"}}),
  "base44/entities/Product.json": JSON.stringify({name:"Product", properties:{price:{type:"number"}}, public:true}),
}, directory => {
  const {schema} = discoverSchema(directory);
  assert.equal(schema.entities.Catalog.access, "public");
  assert.equal(schema.entities.Article.access, "public");
  assert.equal(schema.entities.Product.access, "public");
}));
