import { createPublicKey, verify } from "node:crypto";
import { discoverSchema, tableName } from "./database-schema.mjs";
import { connectSql } from "./database-sql.mjs";
import { createSqlAdapter } from "../dist/adapters.js";

export async function verifyUser(token, config, env) {
  if (!token || token.length > 16384) throw new Error("Login necessário.");
  if (config.authProvider === "firebase") {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Token inválido.");
    const header = JSON.parse(Buffer.from(parts[0], "base64url"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    const project = env.MOON_FIREBASE_PROJECT_ID;
    const now = Date.now() / 1000;
    if (!project || header.alg !== "RS256" || !header.kid || claims.aud !== project ||
      claims.iss !== "https://securetoken.google.com/" + project || typeof claims.exp !== "number" ||
      claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 60 || !claims.sub)
      throw new Error("Token inválido/expirado.");
    const response = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Não foi possível verificar a assinatura Firebase.");
    const jwk = (await response.json()).keys.find(key => key.kid === header.kid);
    if (!jwk || !verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url")))
      throw new Error("Assinatura Firebase inválida.");
    return { id: claims.sub };
  }
  if (!env.MOON_SUPABASE_URL || !env.MOON_SUPABASE_ANON_KEY) throw new Error("Supabase Auth não configurado.");
  const response = await fetch(env.MOON_SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/user", {
    headers: { apikey: env.MOON_SUPABASE_ANON_KEY, Authorization: "Bearer " + token }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Sessão inválida/expirada.");
  const user = await response.json();
  if (!user.id) throw new Error("Usuário inválido.");
  return { id: user.id };
}

export function authorizeQuery(payload, schema, user, options = {}) {
  const definition = Object.entries(schema.entities).find(([name]) => tableName(name) === payload?.table)?.[1];
  if (!definition) throw new Error("Entidade indisponível.");
  if (!options.asServiceRole && !["owner", "public"].includes(definition.access)) throw new Error("Entidade indisponível para acesso pelo navegador.");
  if (!["select", "insert", "update", "delete"].includes(payload.action)) throw new Error("Operação inválida.");
  const fields = definition.fields;
  const operators = ["$eq", "$neq", "$gt", "$gte", "$lt", "$lte", "$in", "$is", "$ilike"];
  const filters = Array.isArray(payload.filters) ? payload.filters : [];
  if (filters.length > 20) throw new Error("Filtros inválidos.");
  for (const filter of filters) if (!Object.hasOwn(fields, filter.field) || !operators.includes(filter.operator)) throw new Error("Filtro inválido.");
  if (payload.select && (!Array.isArray(payload.select) || payload.select.some(key => key !== "*" && !Object.hasOwn(fields, key)))) throw new Error("Projeção inválida.");
  if (payload.order && !Object.hasOwn(fields, payload.order.field)) throw new Error("Ordenação inválida.");
  if (payload.limit != null && (!Number.isSafeInteger(payload.limit) || payload.limit < 0 || payload.limit > 1000)) throw new Error("Limite deve estar entre 0 e 1000.");
  if (payload.offset != null && (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > 100000)) throw new Error("Offset inválido.");

  if (options.asServiceRole) {
    const request = { ...payload, filters: [...filters], limit: payload.limit ?? 100, ...(payload.offset != null ? { offset: payload.offset } : {}) };
    if (["insert", "update"].includes(payload.action)) {
      const records = Array.isArray(payload.values) ? payload.values : [payload.values];
      if (records.length > 100 || (payload.action === "update" && records.length !== 1)) throw new Error("Lote inválido.");
      request.values = records.map(record => {
        if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Registro inválido.");
        const sanitized = {};
        for (const [key, value] of Object.entries(record)) {
          if (Object.hasOwn(fields, key) && !["id", "created_at", "updated_at"].includes(key)) {
            sanitized[key] = value;
          }
        }
        if (payload.action === "insert") {
          sanitized.id = record.id || crypto.randomUUID();
          sanitized.created_at = new Date().toISOString();
          sanitized.updated_at = sanitized.created_at;
          if (fields.user_id) sanitized.user_id = record.user_id || user?.id || "service_role";
        } else {
          sanitized.updated_at = new Date().toISOString();
        }
        return sanitized;
      });
      if (payload.action === "update") request.values = request.values[0];
    }
    return request;
  }

  if (definition.access === "public") {
    if (payload.action !== "select") throw new Error("Entidade pública permite apenas leitura.");
    return { ...payload, filters, limit: payload.limit ?? 100, ...(payload.offset != null ? { offset: payload.offset } : {}) };
  }

  if (!user?.id) throw new Error("Consulta ou usuário inválido.");
  if (["update", "delete"].includes(payload.action) && !filters.some(f => f.field === "id" && f.operator === "$eq" && typeof f.value === "string"))
    throw new Error("Atualização/exclusão exige id.");
  const request = { ...payload, filters: [...filters, { field: "user_id", operator: "$eq", value: user.id }] };
  request.limit = payload.limit ?? 100;
  if (["insert", "update"].includes(payload.action)) {
    const records = Array.isArray(payload.values) ? payload.values : [payload.values];
    if (records.length > 100 || payload.action === "update" && records.length !== 1) throw new Error("Lote inválido.");
    request.values = records.map(record => {
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Registro inválido.");
      for (const [key, value] of Object.entries(record)) {
        const field = Object.hasOwn(fields, key) ? fields[key] : null;
        if (!field || ["id", "created_at", "updated_at", "user_id"].includes(key)) throw new Error("Campo desconhecido ou reservado: " + key);
        if (value === null) { if (field.required) throw new Error("Campo obrigatório: " + key); continue; }
        const valid = field.type === "json" ? true : field.type === "integer" ? Number.isSafeInteger(value)
          : field.type === "number" ? typeof value === "number" && Number.isFinite(value)
          : field.type === "boolean" ? typeof value === "boolean"
          : field.type === "uuid" ? typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
          : field.type === "datetime" ? typeof value === "string" && Number.isFinite(Date.parse(value)) : typeof value === "string";
        if (!valid || field.enum && !field.enum.includes(value)) throw new Error("Valor inválido: " + key);
      }
      if (payload.action === "insert") for (const [key, field] of Object.entries(fields))
        if (field.required && !["id", "created_at", "updated_at", "user_id"].includes(key) && !(key in record)) throw new Error("Campo obrigatório: " + key);
      return { ...record, user_id: user.id };
    });
    if (payload.action === "update") request.values = request.values[0];
  }
  return request;
}
export async function queryDatabase(payload, token, config, env, directory, options = {}) {
  if (!["postgres", "mysql", "supabase"].includes(config.provider)) throw new Error("Este endpoint atende PostgreSQL, Supabase e MySQL.");
  const schema = discoverSchema(directory)?.schema;
  if (!schema) throw new Error("Schema ausente.");
  const definition = Object.entries(schema.entities).find(([name]) => tableName(name) === payload?.table)?.[1];
  let user = options.user || null;
  if (!options.asServiceRole) {
    user = definition?.access === "public" && payload?.action === "select" ? null : (user || await verifyUser(token, config, env));
  }
  const request = authorizeQuery(payload, schema, user, options);
  const connection = await connectSql(config.provider, env.MOON_DATABASE_URL);
  try {
    const adapter = createSqlAdapter(connection, config.provider === "supabase" ? "postgres" : config.provider, schema);
    const table = adapter.from(request.table);
    let query = request.action === "select" ? table.select((request.select || ["*"]).join(","))
      : request.action === "insert" ? table.insert(request.values) : request.action === "update" ? table.update(request.values) : table.delete();
    // Insert data already contains the authoritative owner; filters apply to reads/mutations.
    if (request.action !== "insert") for (const filter of request.filters) query = query.where(filter.field, filter.operator, filter.value);
    if (request.action === "select") {
      if (request.order) query = query.order(request.order.field, { ascending: request.order.ascending });
      query = query.range(request.offset || 0, (request.offset || 0) + request.limit - 1);
    }
    const { data, error } = await query;
    if (error) throw error;
    return { rows: data };
  } finally { await connection.close(); }
}
