import { readFileSync } from "node:fs";
import { createSign, randomUUID } from "node:crypto";
import { compileFirestore, normalizeSchema, schemaHash } from "./database-schema.mjs";

export async function firebaseToken(accountPath) {
  const account = JSON.parse(readFileSync(accountPath, "utf8"));
  if (!account.client_email || !account.private_key || !account.project_id) throw new Error("Conta de serviço Firebase inválida.");
  const encode = v => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const assertion = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
    iss: account.client_email, scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const signer = createSign("RSA-SHA256"); signer.update(assertion);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion + "." + signer.sign(account.private_key, "base64url") }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error("Firebase recusou a conta de serviço. Verifique sua chave e permissões IAM.");
  return { token: data.access_token, project: account.project_id };
}

export async function provisionFirebase(schemaInput, { accountPath, project, location, create = false, replaceRules = false }, request = fetch) {
  const schema = normalizeSchema(schemaInput);
  const credentials = await firebaseToken(accountPath);
  if (credentials.project !== project) throw new Error("A conta de serviço pertence a outro projeto Firebase.");
  const api = async (url, method = "GET", body, missing = false) => {
    const response = await request(url, { method, headers: { Authorization: "Bearer " + credentials.token, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (missing && response.status === 404) return null;
    const data = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(`Firebase HTTP ${response.status}: ${data.error?.message || "falha na operação"}`);
    return data;
  };
  const base = "https://firestore.googleapis.com/v1/projects/" + encodeURIComponent(project) + "/databases";
  const database = base + "/(default)";
  const rulesBase = "https://firebaserules.googleapis.com/v1/projects/" + encodeURIComponent(project);
  const previous = await api(rulesBase + "/releases/cloud.firestore", "GET", undefined, true);
  if (previous && !replaceRules) throw new Error("Este projeto já tem regras Firestore. Autorize explicitamente a substituição no assistente.");
  let existing = await api(database, "GET", undefined, true);
  if (!existing) {
    if (!create || !location) throw new Error("Firestore não existe: autorize a criação e informe a região.");
    let operation = await api(base + "?databaseId=(default)", "POST", { locationId: location, type: "FIRESTORE_NATIVE" });
    for (let i = 0; !operation.done && i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      operation = await api("https://firestore.googleapis.com/v1/" + operation.name);
    }
    if (!operation.done || operation.error) throw new Error("Criação do Firestore pendente ou recusada: confira o console e tente novamente.");
  }
  const probe = database + "/documents/_moon_probe/" + randomUUID();
  try {
    await api(probe + "?currentDocument.exists=false", "PATCH", { fields: { value: { integerValue: "1" } } });
    await api(probe, "PATCH", { fields: { value: { integerValue: "2" } } });
    const read = await api(probe);
    if (read.fields?.value?.integerValue !== "2") throw new Error("Firestore retornou dados inconsistentes.");
  } finally { await api(probe, "DELETE", undefined, true); }
  const ruleset = await api(rulesBase + "/rulesets", "POST", { source: { files: [{ name: "firestore.rules", content: compileFirestore(schema) }] } });
  const release = { name: "projects/" + project + "/releases/cloud.firestore", rulesetName: ruleset.name };
  await api(previous ? rulesBase + "/releases/cloud.firestore" : rulesBase + "/releases", previous ? "PATCH" : "POST",
    previous ? { release, updateMask: "ruleset_name" } : release);
  return { provider: "firebase", schemaHash: schemaHash(schema), checked: ["admin-insert", "admin-select", "admin-update", "admin-delete", "rules-published"], previousRuleset: previous?.rulesetName || null, authentication: "not-tested", note: "As coleções surgem na primeira gravação. Valide autenticação e índices compostos com as consultas da aplicação." };
}
