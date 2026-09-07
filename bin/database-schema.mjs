import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "jsonc-parser";

export const types = ["string", "integer", "number", "boolean", "json", "datetime", "uuid"];
export const identifier = (name) => {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(name) || name.startsWith("_moon_") || ["__proto__", "constructor", "prototype"].includes(name))
    throw new Error(`Nome de tabela/campo inválido: ${name}`);
  return name;
};
export const tableName = (name) => identifier(name.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`));
export function readJson(path) {
  const errors = [];
  const data = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`JSON/JSONC inválido: ${path}`);
  return data;
}
export function normalizeSchema(input) {
  if (input?.version !== 1 || !input.entities || typeof input.entities !== "object" || Array.isArray(input.entities))
    throw new Error("O schema precisa de version: 1 e entities.");
  const schema = { version: 1, entities: {} };
  const names = new Set();
  for (const [entity, definition] of Object.entries(input.entities)) {
    const table = tableName(entity);
    if (names.has(table)) throw new Error(`Entidades colidem na tabela ${table}`);
    names.add(table);
    if (!definition.fields || !["owner", "private"].includes(definition.access))
      throw new Error(`${entity}: informe fields e access (owner ou private).`);
    const fields = {
      id: { type: "uuid", required: true },
      created_at: { type: "datetime", required: true },
      updated_at: { type: "datetime", required: true },
      ...(definition.access === "owner" ? { user_id: { type: "string", required: true } } : {}),
    };
    for (const [key, field] of Object.entries(definition.fields)) {
      identifier(key);
      if (Object.keys(field).some(key => !["type", "required", "enum", "references"].includes(key)))
        throw new Error(`${entity}.${key}: propriedade de schema não suportada; não será ignorada.`);
      if (!types.includes(field.type)) throw new Error(`${entity}.${key}: tipo não suportado.`);
      if (Object.hasOwn(fields, key) && field.type !== fields[key].type) throw new Error(`${entity}.${key}: tipo reservado incompatível.`);
      if (field.enum && (!Array.isArray(field.enum) || !field.enum.length || field.type !== "string" || field.enum.some(v => typeof v !== "string")))
        throw new Error(`${entity}.${key}: enum deve ser uma lista de textos.`);
      if (field.references && (field.type !== "uuid" || field.references.field && field.references.field !== "id"))
        throw new Error("Relacionamentos devem apontar para id e usar uuid.");
      fields[key] = { ...field, required: Boolean(field.required || fields[key]?.required) };
    }
    schema.entities[entity] = { access: definition.access, fields };
  }
  if (!names.size) throw new Error("Nenhuma entidade definida. O assistente precisa conhecer os campos.");
  for (const [entity, def] of Object.entries(schema.entities)) for (const field of Object.values(def.fields)) {
    if (field.references && !schema.entities[field.references.entity])
      throw new Error(`${entity}: relacionamento aponta para entidade inexistente.`);
  }
  return schema;
}
export function schemaHash(schema) {
  const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(normalizeSchema(schema)))).digest("hex");
}
export function discoverSchema(directory) {
  const canonical = resolve(directory, "moon/schema.json");
  if (existsSync(canonical)) return { schema: normalizeSchema(readJson(canonical)), source: canonical };
  const entities = {};
  const folder = resolve(directory, "base44/entities");
  if (existsSync(folder)) for (const file of readdirSync(folder).filter(f => /\.jsonc?$/.test(f))) {
    const entity = readJson(resolve(folder, file));
    const fields = {};
    for (const [name, field] of Object.entries(entity.properties || {})) {
      const type = field.format === "date-time" ? "datetime" : field.format === "uuid" ? "uuid"
        : ["array", "object"].includes(field.type) ? "json" : field.type;
      if (!types.includes(type)) throw new Error(`${file}.${name}: tipo precisa ser definido explicitamente.`);
      fields[name] = { type, required: (entity.required || []).includes(name), ...(field.enum ? { enum: field.enum } : {}) };
    }
    // Do not infer public access from source code.
    entities[entity.name || basename(file).replace(/\.jsonc?$/, "")] = { access: "private", fields };
  }
  return Object.keys(entities).length ? { schema: normalizeSchema({ version: 1, entities }), source: folder } : null;
}
export function discoverEntityNames(directory) {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ["node_modules", "dist", ".git", "build", ".next"].includes(entry.name)) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(jsx?|tsx?|mjs)$/.test(entry.name) && statSync(path).size < 2_000_000)
        for (const match of readFileSync(path, "utf8").matchAll(/\bentities\.([A-Za-z_][A-Za-z0-9_]*)\s*\./g)) names.add(match[1]);
    }
  };
  walk(directory);
  return [...names].sort();
}
const literal = (v) => typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "boolean" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
export function compileSql(input, provider) {
  if (!["postgres", "mysql", "supabase"].includes(provider)) throw new Error("Escolha o dialeto PostgreSQL ou MySQL; SQL genérico não é um driver.");
  const schema = normalizeSchema(input);
  const mysql = provider === "mysql";
  const quote = (name) => (mysql ? "`" : '"') + identifier(name) + (mysql ? "`" : '"');
  const sqlTypes = mysql
    ? { string: "text", integer: "integer", number: "double", boolean: "boolean", json: "json", datetime: "datetime(3)", uuid: "char(36)" }
    : { string: "text", integer: "integer", number: "double precision", boolean: "boolean", json: "jsonb", datetime: "timestamptz", uuid: "uuid" };
  const statements = [];
  for (const [entity, def] of Object.entries(schema.entities)) {
    const table = quote(tableName(entity));
    const columns = Object.entries(def.fields).map(([key, field]) => {
      let column = `${quote(key)} ${sqlTypes[field.type]}${field.required ? " NOT NULL" : ""}${key === "id" ? " PRIMARY KEY" : ""}`;
      if (["created_at", "updated_at"].includes(key)) column += mysql ? " DEFAULT CURRENT_TIMESTAMP(3)" : " DEFAULT CURRENT_TIMESTAMP";
      if (field.enum) column += ` CHECK (${quote(key)} IN (${field.enum.map(literal).join(", ")}))`;
      return column;
    });
    statements.push(`CREATE TABLE ${table} (\n  ${columns.join(",\n  ")}\n)${mysql ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" : ""}`);
  }
  for (const [entity, def] of Object.entries(schema.entities)) {
    const table = quote(tableName(entity));
    for (const [key, field] of Object.entries(def.fields)) if (field.references) {
      statements.push(`ALTER TABLE ${table} ADD FOREIGN KEY (${quote(key)}) REFERENCES ${quote(tableName(field.references.entity))} ("id")`.replace('("id")', `(${quote("id")})`));
    }
    if (provider === "supabase") {
      statements.push(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      if (def.access === "owner") {
        statements.push(`CREATE POLICY moon_owner ON ${table} FOR ALL TO authenticated USING (auth.uid()::text = user_id) WITH CHECK (auth.uid()::text = user_id)`);
        statements.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO authenticated`);
      }
    }
  }
  return statements;
}
export function compileFirestore(input) {
  const schema = normalizeSchema(input);
  const blocks = [];
  for (const [entity, def] of Object.entries(schema.entities)) {
    const fields = Object.entries(def.fields);
    if (fields.some(([, field]) => field.references))
      throw new Error("Firestore não oferece foreign keys com exclusão restrita. Remova references ou implemente essa integridade no backend antes de escolher Firebase.");
    const required = fields.filter(([, f]) => f.required).map(([k]) => k);
    const ruleType = { string: "string", integer: "int", number: "number", boolean: "bool", uuid: "string", datetime: "string" };
    const checks = fields.filter(([, f]) => f.type !== "json").map(([k, f]) =>
      `(!('${k}' in d) || d.${k} is ${ruleType[f.type]})`);
    checks.push(...fields.filter(([, f]) => f.enum).map(([k, f]) => `(!('${k}' in d) || d.${k} in ${JSON.stringify(f.enum)})`));
    const valid = `d.keys().hasAll(${JSON.stringify(required)}) && d.keys().hasOnly(${JSON.stringify(fields.map(([k]) => k))}) && d.id == document && ${checks.join(" && ") || "true"}`;
    blocks.push(`    match /${tableName(entity)}/{document} {
      function valid(d) { return ${valid}; }
      allow get: if ${def.access === "owner" ? "request.auth != null && (!exists(/databases/$(database)/documents/" + tableName(entity) + "/$(document)) || resource.data.user_id == request.auth.uid)" : "false"};
      allow list, delete: if ${def.access === "owner" ? "request.auth != null && resource.data.user_id == request.auth.uid" : "false"};
      allow create: if ${def.access === "owner" ? "request.auth != null && request.resource.data.user_id == request.auth.uid && valid(request.resource.data)" : "false"};
      allow update: if ${def.access === "owner" ? "request.auth != null && resource.data.user_id == request.auth.uid && request.resource.data.user_id == request.auth.uid && valid(request.resource.data)" : "false"};
    }`);
  }
  return `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${blocks.join("\n")}\n  }\n}\n`;
}
