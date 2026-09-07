import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { normalizeSchema, schemaHash } from "./database-schema.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const textHash = value => digest(value.replace(/\r\n/g, "\n").trimEnd());
const localOnly = path => /(^|\/)(\.env(?:\..*)?|\.moon|moon\.config\.json|database-report\.json|.*\.pem|.*\.key|.*\.before-moon|service[-_]?account[^/]*\.json)(\/|$)/i.test(path) || path === "base44/.app.jsonc";
const ignoreRules = [".env", ".env.*", ".moon/", "moon.config.json", "moon/database-report.json", "base44/.app.jsonc", "*.pem", "*.key", "*.before-moon", "*service-account*.json", "*service_account*.json"];
const clients = ["src/api/base44Client.js", "src/api/base44Client.ts", "src/lib/base44Client.js", "src/lib/base44Client.ts"];

function git(directory, args) {
  try { return execFileSync("git", args, { cwd: directory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trimEnd(); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("Git não está instalado/disponível no PATH. Instale o Git e reabra o terminal antes de sincronizar.");
    throw new Error(`Git não concluiu ${args[0]}. Confira autenticação, permissões, conflitos e conexão. Nenhum force-push será usado.`);
  }
}
function root(directory) {
  if (realpathSync(git(directory, ["rev-parse", "--show-toplevel"])) !== realpathSync(directory)) throw new Error("Execute na raiz do repositório do aplicativo (clone completo do GitHub, não a pasta do SDK).");
  if (git(directory, ["branch", "--show-current"]) !== "main") throw new Error("O Base44 sincroniza a branch main. Troque para ela após preservar suas alterações.");
  if (JSON.parse(readFileSync(resolve(directory, "package.json"))).name === "@moon/sdk") throw new Error("Use a pasta do aplicativo, não a do SDK.");
}
function statePath(directory) { return resolve(directory, git(directory, ["rev-parse", "--git-path", "moon-sync.json"])); }
function readState(directory) {
  root(directory);
  const path = statePath(directory);
  if (!existsSync(path)) throw new Error("Execute moon sync init primeiro.");
  const state = JSON.parse(readFileSync(path, "utf8"));
  if (state.version !== 1 || state.remote !== git(directory, ["remote", "get-url", "origin"])) throw new Error("O vínculo com origin mudou. Revise a configuração; sincronização bloqueada.");
  // Reject separate push destinations: validation and push must target the same repository.
  if (state.remote !== git(directory, ["remote", "get-url", "--push", "--all", "origin"])) throw new Error("origin usa destinos diferentes ou múltiplos para leitura e envio.");
  return state;
}
function safeText(path, text) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|["']private_key["']\s*:\s*["']|(?:postgres(?:ql)?|mysql):\/\/[^\s"']+:[^\s"']+@/.test(text))
    throw new Error(`Possível credencial administrativa em ${path}. Remova-a do histórico antes de sincronizar.`);
  if (path === "package.json") {
    const pkg = JSON.parse(text);
    for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) if (/^(?:file:|link:|\/|[A-Za-z]:\\)/.test(version))
      throw new Error("package.json contém dependência de uma pasta local. Ela não funcionará no Base44; mantenha as dependências originais no código compartilhado.");
  }
}
function tree(directory, ref, state) {
  const paths = git(directory, ["ls-tree", "-r", "--name-only", "-z", ref]).split("\0").filter(Boolean);
  for (const path of paths) {
    if (localOnly(path)) throw new Error(`Arquivo local/credencial versionado: ${path}. Retire-o do Git e, se já publicado, revogue os segredos expostos.`);
    const mode = git(directory, ["ls-tree", ref, "--", path]).slice(0, 6);
    if (["120000", "160000"].includes(mode)) throw new Error(`Link/submódulo não suportado no fluxo protegido: ${path}`);
    const text = git(directory, ["show", `${ref}:${path}`]);
    safeText(path, text);
  }
  if (state) for (const [path, hash] of Object.entries(state.protected)) {
    if (!paths.includes(path) || textHash(git(directory, ["show", `${ref}:${path}`])) !== hash)
      throw new Error(`Contrato protegido alterado: ${path}. Recebimento/envio bloqueado; peça revisão técnica antes de mudar a integração.`);
  }
}
function clean(directory) {
  if (git(directory, ["status", "--porcelain"])) throw new Error("Há alterações locais. Revise e faça commit antes de sincronizar; o Moon não faz stash nem sobrescreve arquivos automaticamente.");
}
function localCheck(directory, state, checkConfiguration = true) {
  for (const [path, hash] of Object.entries(state.protected)) {
    const file = resolve(directory, path);
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || textHash(readFileSync(file, "utf8")) !== hash)
      throw new Error(`Contrato protegido alterado: ${path}. Nenhum banco será modificado pela sincronização.`);
  }
  const config = resolve(directory, "moon.config.json");
  if (checkConfiguration && (!existsSync(config) || digest(readFileSync(config)) !== state.localConfigHash))
    throw new Error("A configuração local do banco mudou após o vínculo. Revise-a antes de sincronizar.");
}

export function initializeSync(directory, print = console.log, { refreshLocal = false } = {}) {
  root(directory);
  if (existsSync(statePath(directory))) {
    const state = readState(directory);
    localCheck(directory, state, !refreshLocal);
    if (refreshLocal) {
      const config = JSON.parse(readFileSync(resolve(directory, "moon.config.json")));
      const contract = JSON.parse(readFileSync(resolve(directory, "moon.contract.json")));
      if (config.provider !== contract.localProvider) throw new Error("Trocar o provedor exige revisão do contrato; refresh-local só aceita reconexão ao mesmo provedor.");
      state.localConfigHash = digest(readFileSync(resolve(directory, "moon.config.json")));
      writeFileSync(statePath(directory), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
      print("Vínculo atualizado para a configuração local revisada. Schema e arquivos protegidos não foram alterados.");
    } else print("Sincronização já vinculada. Use moon sync status.");
    return;
  }
  for (const path of ["moon", "moon.config.json", "moon/schema.json", ".gitignore", "moon.contract.json", "moon/AI-INSTRUCTIONS.md"])
    if (existsSync(resolve(directory, path)) && lstatSync(resolve(directory, path)).isSymbolicLink()) throw new Error(`Link simbólico não permitido na configuração: ${path}`);
  if (/^(?:120000|160000) /m.test(git(directory, ["ls-files", "--stage"]))) throw new Error("Links/submódulos versionados exigem revisão antes de configurar a sincronização protegida.");
  const remote = git(directory, ["remote", "get-url", "origin"]);
  if (/https?:\/\/[^/]*@/.test(remote)) throw new Error("Não use tokens/senhas na URL de origin; configure um gerenciador de credenciais.");
  if (remote !== git(directory, ["remote", "get-url", "--push", "--all", "origin"])) throw new Error("origin deve ter um único destino de envio, igual ao destino de leitura.");
  const configPath = resolve(directory, "moon.config.json");
  const schemaPath = resolve(directory, "moon/schema.json");
  if (!existsSync(configPath) || !existsSync(schemaPath)) throw new Error("Prepare o banco deste aplicativo com moon db . antes de gerar o contrato.");
  const schema = normalizeSchema(JSON.parse(readFileSync(schemaPath)));
  const config = JSON.parse(readFileSync(configPath));
  if (!["supabase", "firebase", "postgres", "mysql"].includes(config.provider)) throw new Error("Escolha um banco suportado antes de vincular a sincronização.");
  const tracked = git(directory, ["ls-files", "-z"]).split("\0").filter(Boolean);
  if (tracked.some(localOnly)) throw new Error("Existem arquivos locais/credenciais no índice Git. Retire-os do versionamento antes de iniciar a sincronização (os arquivos devem permanecer no disco).");
  const clientFiles = clients.filter(path => existsSync(resolve(directory, path)));
  if (!clientFiles.length) throw new Error("Cliente Base44 não encontrado. Use um clone completo do projeto conectado ao GitHub.");
  for (const path of clientFiles) {
    const text = readFileSync(resolve(directory, path), "utf8");
    if (!text.includes("@base44/sdk") || text.includes("@moon/sdk")) throw new Error("O cliente compartilhado já foi substituído. Recupere o cliente original Base44 antes de vincular; a adaptação Moon agora acontece somente na cópia local de execução.");
  }
  safeText("package.json", readFileSync(resolve(directory, "package.json"), "utf8"));
  const protectedPaths = ["moon.contract.json", "moon/AI-INSTRUCTIONS.md", "moon/schema.json", ...clientFiles];
  const contract = {
    version: 1, platform: "base44", branch: "main", localProvider: config.provider,
    schema, schemaHash: schemaHash(schema), protectedPaths,
    rules: ["Read moon/AI-INSTRUCTIONS.md before editing.", "Preserve the existing Base44 client in shared source; Moon adapts it only in a local runtime copy.", "Never commit credentials, local configuration, database records or runtime files.", "Never remove/rename fields, change field types or access policies without a reviewed migration.", "Propose schema additions in moon/schema.proposed.json; do not modify the accepted schema.", "Git synchronization never migrates the local database and does not synchronize records between databases."],
  };
  const hasContract = existsSync(resolve(directory, "moon.contract.json"));
  if (hasContract) {
    const existing = JSON.parse(readFileSync(resolve(directory, "moon.contract.json")));
    if (existing.version !== 1 || existing.branch !== "main" || existing.localProvider !== config.provider ||
        existing.schemaHash !== schemaHash(schema) || schemaHash(existing.schema) !== schemaHash(schema) ||
        JSON.stringify(existing.protectedPaths) !== JSON.stringify(protectedPaths) || !existsSync(resolve(directory, "moon/AI-INSTRUCTIONS.md")))
      throw new Error("O contrato compartilhado não corresponde à configuração local. Revise antes de vincular este computador.");
  } else if (existsSync(resolve(directory, "moon/AI-INSTRUCTIONS.md"))) throw new Error("Instruções existentes sem contrato; não serão sobrescritas.");
  mkdirSync(resolve(directory, "moon"), { recursive: true });
  const ignore = resolve(directory, ".gitignore");
  const original = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const missingIgnores = ignoreRules.filter(rule => !original.split(/\r?\n/).includes(rule));
  if (missingIgnores.length) writeFileSync(ignore, original + "\n# Moon: local configuration and runtime (never sync)\n" + missingIgnores.join("\n") + "\n");
  if (!hasContract) {
    writeFileSync(resolve(directory, "moon.contract.json"), JSON.stringify(contract, null, 2) + "\n", { flag: "wx" });
    writeFileSync(resolve(directory, "moon/AI-INSTRUCTIONS.md"), "# Moon / Base44 integration contract\n\nRead ../moon.contract.json before editing.\n\n" + contract.rules.map(rule => "- " + rule).join("\n") + "\n\nThese instructions are advisory. Moon validates protected files locally before sync. Shared Base44 previews keep using Base44; local Moon runtime uses the user's configured database. Credentials and database records never travel through Git. Preserve the application's existing functionality.\n", { flag: "wx" });
  }
  const state = { version: 1, remote, localConfigHash: digest(readFileSync(configPath)), protected: Object.fromEntries(protectedPaths.map(path => [path, textHash(readFileSync(resolve(directory, path), "utf8"))])) };
  writeFileSync(statePath(directory), JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  print("Contrato gerado sem credenciais. Na IA do Base44, instrua: leia moon.contract.json e moon/AI-INSTRUCTIONS.md antes de editar.");
  print("Revise os arquivos e faça commit; depois execute moon sync push. A conexão bidirecional deve ser ativada pelo proprietário no painel Base44 (Builder+).");
}

export function syncProject(directory, action, print = console.log, options = {}) {
  if (action === "init") return initializeSync(directory, print, options);
  const state = readState(directory);
  localCheck(directory, state);
  if (action === "status") { print(git(directory, ["status", "--short", "--branch"])); print("Contrato local válido. Status remoto só é atualizado por push/pull. Nenhum banco foi acessado."); return; }
  if (!["push", "pull"].includes(action)) throw new Error("Use moon sync init|status|push|pull [pasta].");
  clean(directory);
  git(directory, ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  const head = git(directory, ["rev-parse", "HEAD"]);
  const remote = git(directory, ["rev-parse", "refs/remotes/origin/main"]);
  const base = git(directory, ["merge-base", head, remote]);
  if (action === "push" && base !== remote || action === "pull" && base !== head && remote !== head)
    throw new Error("As versões local/remota precisam de revisão ou merge. Nenhum arquivo foi sobrescrito. Resolva os commits divergentes e repita.");
  tree(directory, head, state);
  const target = action === "push" ? head : remote;
  const commits = git(directory, ["rev-list", `${base}..${target}`]).split("\n").filter(Boolean);
  // Inspect every incoming/outgoing commit, not just the final tree: secrets can remain in history.
  for (const commit of commits) tree(directory, commit);
  tree(directory, target, state);
  clean(directory);
  localCheck(directory, state);
  if (git(directory, ["rev-parse", "HEAD"]) !== head) throw new Error("HEAD mudou durante a verificação. Repita a sincronização.");
  if (action === "push") {
    git(directory, ["push", "--no-follow-tags", "origin", `${head}:refs/heads/main`]);
    print("Código enviado à main. A sincronização/publicação no Base44 depende da integração deles; o banco local não foi alterado.");
  } else {
    git(directory, ["-c", "core.hooksPath=", "merge", "--ff-only", remote]);
    print("Código recebido e contrato preservado. Reinicie moon run para usar a nova cópia local. Nenhuma migração foi executada.");
  }
}

export function validateSyncIfPresent(directory) {
  let path;
  try { path = statePath(directory); } catch { return; }
  if (existsSync(path)) localCheck(directory, readState(directory));
}

export function acceptMigratedSchema(directory, schema) {
  let path;
  try { path = statePath(directory); } catch { return; }
  if (!existsSync(path)) return;
  const state = readState(directory);
  const contractPath = resolve(directory, "moon.contract.json");
  const contract = JSON.parse(readFileSync(contractPath));
  contract.schema = normalizeSchema(schema);
  contract.schemaHash = schemaHash(schema);
  writeFileSync(contractPath, JSON.stringify(contract, null, 2) + "\n");
  for (const name of ["moon.contract.json", "moon/schema.json"]) state.protected[name] = textHash(readFileSync(resolve(directory, name), "utf8"));
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}
