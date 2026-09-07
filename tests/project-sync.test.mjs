import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSync, syncProject } from "../bin/project-sync.mjs";
import { prepareLocalRuntime } from "../bin/local-runtime.mjs";
import { normalizeSchema } from "../bin/database-schema.mjs";

const silent = () => {};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (dir, path, value) => { mkdirSync(join(dir, path, ".."), {recursive:true}); writeFileSync(join(dir, path), value); };
const commit = (dir, msg) => { git(dir, "add", "."); git(dir, "commit", "-m", msg); };
const schema = normalizeSchema({version:1, entities:{Note:{access:"owner",fields:{title:{type:"string"}}}}});
async function fixture(run) {
  const folder = mkdtempSync(join(tmpdir(), "moon-sync-test-"));
  const local = join(folder,"local"), remote = join(folder,"remote.git"), editor = join(folder,"editor");
  mkdirSync(local);
  try {
    git(folder,"init","--bare", "--initial-branch=main",remote);
    git(local,"init","--initial-branch=main");
    git(local,"config","user.name","Moon Test"); git(local,"config","user.email","test@example.invalid");
    put(local,"package.json", JSON.stringify({name:"test-app", dependencies:{"@base44/sdk":"0.8.0"}}));
    put(local,"src/api/base44Client.js", "import {createClient} from '@base44/sdk'; export const base44=createClient({});\n");
    put(local,"src/app.js", "export const title = 'before';\n");
    put(local,".gitignore","node_modules/\n.env*\nmoon.config.json\nmoon/database-report.json\n");
    commit(local,"initial"); git(local,"remote","add","origin",remote); git(local,"push","-u","origin","main");
    put(local,"moon.config.json",JSON.stringify({version:1,provider:"supabase",env:["MOON_DATABASE_URL"]}));
    put(local,".env.local","MOON_DATABASE_URL=postgres://user:LOCAL_SECRET@host/db\n");
    put(local,"moon/schema.json",JSON.stringify(schema));
    initializeSync(local,silent); commit(local,"contract"); syncProject(local,"push",silent);
    git(folder,"clone",remote,editor);
    git(editor,"config","user.name","Editor Test"); git(editor,"config","user.email","editor@example.invalid");
    await run({folder,local,remote,editor});
  } finally { rmSync(folder,{recursive:true,force:true}); }
}

test("Git real: ida/volta preserva configuração privada e contratos por projeto", () => fixture(({local,editor,remote}) => {
  const config = readFileSync(join(local,"moon.config.json"),"utf8");
  const env = readFileSync(join(local,".env.local"),"utf8");
  const contract = readFileSync(join(local,"moon.contract.json"),"utf8");
  assert.doesNotMatch(contract,/LOCAL_SECRET|postgres:\/\//);
  put(editor,"src/app.js","export const title = 'Base44 edit';\n"); commit(editor,"AI edit"); git(editor,"push","origin","main");
  syncProject(local,"pull",silent);
  assert.match(readFileSync(join(local,"src/app.js"),"utf8"),/Base44 edit/);
  assert.equal(readFileSync(join(local,"moon.config.json"),"utf8"),config);
  assert.equal(readFileSync(join(local,".env.local"),"utf8"),env);
  put(local,"src/app.js","export const title = 'Local edit';\n"); commit(local,"local edit"); syncProject(local,"push",silent);
  assert.equal(git(local,"rev-parse","HEAD"),git(remote,"rev-parse","main"));
  assert.doesNotMatch(git(remote,"ls-tree","-r","--name-only","main"),/\.env|moon.config/);
}));

test("pull bloqueia alteração remota do contrato antes de modificar HEAD", () => fixture(({local,editor}) => {
  const head = git(local,"rev-parse","HEAD");
  put(editor,"src/api/base44Client.js","export const base44 = {};\n"); commit(editor,"bad AI edit"); git(editor,"push","origin","main");
  assert.throws(()=>syncProject(local,"pull",silent),/Contrato protegido/);
  assert.equal(git(local,"rev-parse","HEAD"),head);
}));

test("push/pull recusam divergência e preservam alterações sem commit", () => fixture(({local,editor}) => {
  put(local,"src/app.js","local uncommitted");
  assert.throws(()=>syncProject(local,"pull",silent),/alterações locais/);
  commit(local,"local branch");
  put(editor,"src/app.js","remote edit"); commit(editor,"remote branch"); git(editor,"push","origin","main");
  assert.throws(()=>syncProject(local,"push",silent),/divergentes/);
  assert.throws(()=>syncProject(local,"pull",silent),/divergentes/);
  assert.equal(readFileSync(join(local,"src/app.js"),"utf8"),"local uncommitted");
}));

test("segredo removido no último commit continua bloqueado no histórico", () => fixture(({local,editor}) => {
  put(editor,"credentials.json",JSON.stringify({private_key:"SECRET"})); commit(editor,"accidental secret");
  git(editor,"rm","credentials.json"); git(editor,"commit","-m","remove secret"); git(editor,"push","origin","main");
  const head = git(local,"rev-parse","HEAD");
  assert.throws(()=>syncProject(local,"pull",silent),/credencial administrativa/);
  assert.equal(git(local,"rev-parse","HEAD"),head);
}));

test("configuração do banco alterada localmente bloqueia sincronização", () => fixture(({local}) => {
  put(local,"moon.config.json",JSON.stringify({provider:"mysql"}));
  assert.throws(()=>syncProject(local,"status",silent),/configuração local/);
}));

test("refresh-local permite reconexão revisada sem aprovar alterações no cliente", () => fixture(({local}) => {
  put(local,"moon.config.json",JSON.stringify({provider:"supabase",configuredAt:"new"}));
  initializeSync(local,silent,{refreshLocal:true});
  syncProject(local,"status",silent);
  put(local,"src/api/base44Client.js","bad change");
  assert.throws(()=>initializeSync(local,silent,{refreshLocal:true}),/Contrato protegido/);
}));

test("destino de push adicional não passa pela validação do remoto", () => fixture(({local,remote,folder}) => {
  git(local,"config","--add","remote.origin.pushurl",remote);
  git(local,"config","--add","remote.origin.pushurl",join(folder,"unapproved.git"));
  assert.throws(()=>syncProject(local,"push",silent),/múltiplos/);
}));

test("cópia de execução não muda cliente original nem inclui segredos/Git", () => fixture(({local}) => {
  const original = readFileSync(join(local,"src/api/base44Client.js"),"utf8");
  const runtime = prepareLocalRuntime(local);
  put(runtime,"src/api/base44Client.js","local Moon adapter");
  assert.equal(readFileSync(join(local,"src/api/base44Client.js"),"utf8"),original);
  for (const path of [".git",".env.local","moon.config.json",".moon"]) assert.equal(existsSync(join(runtime,path)),false);
  assert.equal(git(local,"status","--porcelain"),"");
}));

test("um segundo computador pode vincular o contrato existente sem sobrescrevê-lo", () => fixture(({local,editor}) => {
  put(editor,"moon.config.json",readFileSync(join(local,"moon.config.json"),"utf8"));
  const original=readFileSync(join(editor,"moon.contract.json"),"utf8");
  initializeSync(editor,silent);
  assert.equal(readFileSync(join(editor,"moon.contract.json"),"utf8"),original);
  syncProject(editor,"status",silent);
}));
