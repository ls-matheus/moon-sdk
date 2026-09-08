import type { AuthAdapter, DatabaseAdapter, EntityQuery } from "./types.js";
import { dictionaries, type Provider, type ProviderDictionary } from "./dictionaries.js";
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAuthAdapter } from './supabase-auth.js';

export interface QueryRequest {
  table: string;
  select?: string[];
  filters: Array<{ field: string; operator: string; value: unknown }>;
  order?: { field: string; ascending: boolean };
  limit?: number;
  offset?: number;
  action: "select" | "insert" | "update" | "delete";
  values?: unknown;
}

export interface DatabaseDriver {
  provider: Provider;
  auth?: AuthAdapter;
  execute<T = Record<string, unknown>>(request: QueryRequest): Promise<{ rows: T[]; count?: number }>;
}

type QueryState = Omit<QueryRequest, "table" | "action">;
const missingAuth = new Proxy({}, {
  get() { return () => Promise.reject(new Error("No authentication provider configured for this adapter")); },
}) as AuthAdapter;

function makeQuery<T>(driver: DatabaseDriver, dictionary: ProviderDictionary, table: string, state: QueryState, action: QueryRequest["action"], values?: unknown): EntityQuery<T> {
  const request: QueryRequest = { ...state, table, action, values, filters: state.filters ?? [] };
  const query = {
    select(columns = "*") { request.select = columns.split(",").map((column) => column.trim()); return query; },
    order(column: string, options: { ascending?: boolean } = {}) { request.order = { field: column, ascending: options.ascending ?? true }; return query; },
    limit(count: number) { request.limit = count; return query; },
    range(from: number, to: number) { request.offset = from; request.limit = to - from + 1; return query; },
    eq(column: string, value: unknown) { request.filters.push({ field: column, operator: "$eq", value }); return query; },
    where(column: string, operator: string, value: unknown) { request.filters.push({ field: column, operator, value }); return query; },
    then<TResult = { data: T[] | null; error: Error | null }>(onfulfilled?: ((value: { data: T[] | null; error: Error | null }) => TResult | PromiseLike<TResult>) | null): Promise<TResult> {
      const result = driver.execute<T>(request)
        .then(({ rows }) => ({ data: rows, error: null as Error | null }))
        .catch((error) => ({ data: null, error: error instanceof Error ? error : new Error(String(error)) }));
      return result.then(onfulfilled as ((value: { data: T[] | null; error: Error | null }) => TResult | PromiseLike<TResult>) | undefined);
    },
  } as EntityQuery<T>;
  // Keep the dictionary attached for adapters that need provider-specific behavior.
  void dictionary;
  return query;
}

export function createAdapter(driver: DatabaseDriver): DatabaseAdapter {
  const dictionary = dictionaries[driver.provider];
  return {
    from<T = Record<string, unknown>>(table: string) {
      const normalized = dictionary.tableName(table);
      const state = { filters: [] as QueryRequest["filters"] };
      return {
        select(columns = "*") { return makeQuery<T>(driver, dictionary, normalized, state, "select").select(columns); },
        insert(values: Partial<T> | Partial<T>[]) { return makeQuery<T>(driver, dictionary, normalized, state, "insert", values); },
        update(values: Partial<T>) { return makeQuery<T>(driver, dictionary, normalized, state, "update", values); },
        delete() { return makeQuery<T>(driver, dictionary, normalized, state, "delete"); },
      };
    },
    auth: driver.auth ?? missingAuth,
  };
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, parameters: unknown[]): Promise<{ rows: T[] }>;
  transaction?<T>(run: (connection: SqlExecutor) => Promise<T>): Promise<T>;
}

export function createSqlAdapter(executor: SqlExecutor, provider: "postgres" | "mysql" | "sql" = "postgres", schema?: { entities: Record<string, { fields: Record<string, { type: string }> }> }): DatabaseAdapter {
  if (provider === "sql") throw new Error("Escolha um dialeto concreto: postgres ou mysql.");
  const dictionary = dictionaries[provider];
  const quote = (field: string) => dictionary.quoteIdentifier(dictionary.columnName(field));
  const normalize = (value: unknown) => value && typeof value === "object" ? JSON.stringify(value) : value;
  const timestamp = () => provider === "mysql" ? new Date().toISOString().replace("T", " ").replace("Z", "") : new Date().toISOString();
  const driver: DatabaseDriver = {
    provider,
    async execute<T>(request: QueryRequest) {
      const table = dictionary.quoteIdentifier(request.table);
      const params: unknown[] = [];
      const bind = (value: unknown) => { params.push(normalize(value)); return dictionary.placeholders(params.length); };
      const conditions = () => request.filters.map(({ field, operator, value }) => {
        const column = quote(field);
        if (operator === "$in") {
          if (!Array.isArray(value)) throw new Error("$in exige uma lista.");
          return value.length ? column + " IN (" + value.map(bind).join(", ") + ")" : "1 = 0";
        }
        if (value === null && ["$eq", "$is", "$neq"].includes(operator)) return column + (operator === "$neq" ? " IS NOT NULL" : " IS NULL");
        if (operator === "$is" && typeof value !== "boolean") throw new Error("$is aceita null ou boolean.");
        if (operator === "$ilike") return provider === "mysql" ? "LOWER(" + column + ") LIKE LOWER(" + bind(value) + ")" : column + " ILIKE " + bind(value);
        const op = dictionary.operators[operator];
        if (!op) throw new Error("Operador não suportado: " + operator);
        return column + " " + (operator === "$is" ? "=" : op) + " " + bind(value);
      }).join(" AND ");
      const projection = (request.select || ["*"]).map(field => field === "*" ? "*" : quote(field)).join(", ");
      const pagination = (value: number | undefined) => {
        if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Paginação deve ser um inteiro não negativo.");
        return value;
      };
      if (request.action === "select") {
        const where = conditions();
        let sql = "SELECT " + projection + " FROM " + table + (where ? " WHERE " + where : "");
        if (request.order) sql += " ORDER BY " + quote(request.order.field) + (request.order.ascending ? " ASC" : " DESC");
        const limit = pagination(request.limit), offset = pagination(request.offset);
        if (limit != null) sql += " LIMIT " + (provider === "mysql" ? String(limit) : bind(limit));
        else if (offset != null && provider === "mysql") sql += " LIMIT 18446744073709551615";
        if (offset != null) sql += " OFFSET " + (provider === "mysql" ? String(offset) : bind(offset));
        return executor.query<T>(sql, params);
      }
      if (request.action === "insert") {
        const values = Array.isArray(request.values) ? request.values : [request.values];
        if (!values.length) return { rows: [] as T[] };
        const insert = async (connection: SqlExecutor) => {
          const rows: T[] = [];
          for (const value of values) {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Registro inválido.");
            const record = { id: crypto.randomUUID(), created_at: timestamp(), updated_at: timestamp(), ...value };
            const keys = Object.keys(record);
            const parameters = keys.map(k => normalize((record as Record<string, unknown>)[k]));
            const sql = "INSERT INTO " + table + " (" + keys.map(quote).join(", ") + ") VALUES (" + keys.map((_, i) => dictionary.placeholders(i + 1)).join(", ") + ")";
            const result = await connection.query<T>(sql + (provider === "postgres" ? " RETURNING " + projection : ""), parameters);
            if (provider === "postgres") rows.push(...result.rows);
            else rows.push(...(await connection.query<T>("SELECT " + projection + " FROM " + table + " WHERE " + quote("id") + " = ?", [record.id])).rows);
          }
          return { rows };
        };
        if (executor.transaction) return executor.transaction(insert);
        if (provider === "mysql" || values.length > 1) throw new Error("O executor precisa oferecer transaction para esta gravação atômica.");
        return insert(executor);
      }
      if (!request.filters.length) throw new Error("Atualização/exclusão exige filtro explícito.");
      let sql: string;
      if (request.action === "update") {
        const value = request.values as Record<string, unknown>;
        if (!value || Array.isArray(value) || "id" in value) throw new Error("Atualização inválida; id é imutável.");
        const record = { ...value, updated_at: timestamp() };
        sql = "UPDATE " + table + " SET " + Object.entries(record).map(([k, v]) => quote(k) + " = " + bind(v)).join(", ");
      } else sql = "DELETE FROM " + table;
      const filterStart = params.length;
      const where = conditions();
      sql += " WHERE " + where;
      if (provider === "postgres") return executor.query<T>(sql + " RETURNING " + projection, params);
      if (!executor.transaction) throw new Error("MySQL precisa de um executor com transaction para retornar registros com consistência.");
      return executor.transaction(async connection => {
        const selected = await connection.query<Record<string, unknown>>("SELECT * FROM " + table + " WHERE " + where + " FOR UPDATE", params.slice(filterStart));
        await connection.query(sql, params);
        if (request.action === "delete" || !selected.rows.length) return { rows: selected.rows as T[] };
        const ids = selected.rows.map(row => row.id);
        return connection.query<T>("SELECT " + projection + " FROM " + table + " WHERE " + quote("id") + " IN (" + ids.map(() => "?").join(", ") + ")", ids);
      });
    },
  };
  return createAdapter({
    ...driver,
    async execute<T>(request: QueryRequest) {
      const result = await driver.execute<Record<string, unknown>>(request);
      const definition = Object.entries(schema?.entities || {}).find(([name]) => dictionary.tableName(name) === request.table)?.[1];
      return { rows: result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
        const type = definition?.fields[key]?.type;
        if (value == null) return [key, value];
        if (value instanceof Date) return [key, value.toISOString()];
        if (type === "boolean") return [key, Boolean(value)];
        if (type === "json" && typeof value === "string") return [key, JSON.parse(value)];
        if (type === "datetime" && typeof value === "string") return [key, new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z").toISOString()];
        return [key, value];
      }))) as T[] };
    },
  });
}

/** Firestore compat/Admin-style client. Use authenticated client credentials for user access. */
export function createFirebaseAdapter(firestore: any, auth: DatabaseAdapter["auth"], scoped = false, publicTables: string[] = []): DatabaseAdapter {
  return createAdapter({
    provider: "firebase", auth,
    async execute<T>(request: QueryRequest) {
      const collection = firestore.collection(request.table);
      const publicTable = publicTables.includes(request.table);
      if (publicTable && request.action !== 'select') throw new Error('Entidade pública permite apenas leitura.');
      const user = scoped && !publicTable ? (await auth.getUser()).user : null;
      if (scoped && !publicTable && !user) throw new Error("Login necessário.");
      if (request.action === "select") {
        let reference = user ? collection.where("user_id", "==", user.id) : collection;
        for (const filter of request.filters) {
          const operator = dictionaries.firebase.operators[filter.operator];
          if (!operator) throw new Error("Operador Firestore não suportado: " + filter.operator);
          reference = reference.where(filter.field, operator, filter.value);
        }
        if (request.order) reference = reference.orderBy(request.order.field, request.order.ascending ? "asc" : "desc");
        if (request.limit != null && (!Number.isSafeInteger(request.limit) || request.limit < 0)) throw new Error("Limite inválido.");
        if (request.offset != null && (!Number.isSafeInteger(request.offset) || request.offset < 0)) throw new Error('Offset inválido.');
        if (request.limit === 0) return { rows: [] as T[] };
        let skip = 0;
        if (request.offset) {
          if (reference.offset) reference = reference.offset(request.offset);
          else skip = request.offset;
        }
        if (request.limit != null) reference = reference.limit(request.limit + skip);
        const snapshot = await reference.get();
        const rows = snapshot.docs.slice(skip).map((doc: any) => ({ ...doc.data(), id: doc.id }));
        return { rows: rows.map((row: any) => !request.select || request.select.includes("*") ? row : Object.fromEntries(request.select.map(key => [key, row[key]]))) as T[] };
      }
      if (request.action === "insert") {
        const values = Array.isArray(request.values) ? request.values : [request.values];
        if (values.length > 500) throw new Error("Lote Firestore limitado a 500 documentos.");
        return firestore.runTransaction(async (transaction: any) => {
          const records = values.map((value: any) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Registro inválido.");
            const id = value.id || crypto.randomUUID();
            if (typeof id !== "string" || id.includes("/")) throw new Error("ID inválido.");
            return { ref: collection.doc(id), value: { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...value, id, ...(user ? { user_id: user.id } : {}) } };
          });
          const ids = new Set(records.map(record => record.value.id));
          if (ids.size !== records.length) throw new Error("IDs duplicados no lote.");
          for (const record of records) if ((await transaction.get(record.ref)).exists) throw new Error("Registro já existe.");
          for (const record of records) transaction.set(record.ref, record.value);
          return { rows: records.map(record => record.value) as T[] };
        });
      }
      const filter = request.filters[0];
      if (request.filters.length !== 1 || filter.field !== "id" || filter.operator !== "$eq" || typeof filter.value !== "string" || filter.value.includes("/"))
        throw new Error("Atualização/exclusão Firestore exige um único filtro id.");
      const ref = collection.doc(filter.value);
      return firestore.runTransaction(async (transaction: any) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return { rows: [] as T[] };
        const previous = { ...snapshot.data(), id: snapshot.id };
        if (user && previous.user_id !== user.id) throw new Error("Acesso negado.");
        if (request.action === "delete") { transaction.delete(ref); return { rows: [previous] as T[] }; }
        if (!request.values || typeof request.values !== "object" || Array.isArray(request.values) || "id" in request.values) throw new Error("Atualização inválida.");
        const next = { ...previous, ...request.values, updated_at: new Date().toISOString(), ...(user ? { user_id: user.id } : {}) };
        transaction.update(ref, next);
        return { rows: [next] as T[] };
      });
    },
  });
}

export function createSupabaseAdapter(client: SupabaseClient): DatabaseAdapter {
  return { from: client.from.bind(client) as unknown as DatabaseAdapter['from'], auth: createSupabaseAuthAdapter(client.auth) };
}

/** Local-only adapter for development and previews when no remote database is configured. */
export function createMemoryAdapter(storage?: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }): DatabaseAdapter {
  const memory = new Map<string, Record<string, unknown>[]>();
  const read = (table: string) => {
    if (!memory.has(table)) {
      let rows: Record<string, unknown>[] = [];
      try { rows = JSON.parse(storage?.getItem(`moon:table:${table}`) || "[]"); } catch { /* use empty table */ }
      memory.set(table, Array.isArray(rows) ? rows : []);
    }
    return memory.get(table)!;
  };
  const save = (table: string) => storage?.setItem(`moon:table:${table}`, JSON.stringify(read(table)));
  const localUserKey = "moon:local-user";
  const auth: AuthAdapter = {
    async getSession() { const user = await this.getUser(); return { session: user.user ? { user: user.user, access_token: "moon-local-session" } : null }; },
    async getUser() { let user: Record<string, unknown> | null = null; try { user = JSON.parse(storage?.getItem(localUserKey) || "null"); } catch { /* empty session */ } return { user: user as any }; },
    async signInWithPassword({ email }) { const user = { id: `local-${encodeURIComponent(email)}`, email }; storage?.setItem(localUserKey, JSON.stringify(user)); return { user, session: { user, access_token: "moon-local-session" } }; },
    async signUp(credentials) { return this.signInWithPassword(credentials); },
    async signOut() { storage?.removeItem(localUserKey); },
    async updateUser(attributes) { const current = (await this.getUser()).user || {}; const user = { ...current, ...attributes }; storage?.setItem(localUserKey, JSON.stringify(user)); return { user: user as any }; },
    async resetPasswordForEmail() {},
    async signInWithOAuth() { throw new Error("OAuth não está disponível no modo local."); },
    async verifyOtp() {}, async resend() {},
    onAuthStateChange() { return { unsubscribe() {} }; },
  };
  const driver: DatabaseDriver = {
    provider: "sql",
    auth,
    async execute<T>(request: QueryRequest) {
      const rows = read(request.table);
      const predicates = request.filters.map(({ field, operator, value }) => {
        if (operator === "$in" && !Array.isArray(value)) throw new Error("$in exige uma lista.");
        if (!["$eq", "$is", "$neq", "$gt", "$gte", "$lt", "$lte", "$in", "$ilike"].includes(operator)) throw new Error("Operador não suportado: " + operator);
        const pattern = operator === "$ilike" ? new RegExp('^' + String(value).split('').map(char => char === '%' ? '.*' : char === '_' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'is') : undefined;
        return (row: Record<string, unknown>) => {
          const actual = row[field] as any;
          const expected = value as any;
          switch (operator) {
            case "$eq": case "$is": return actual === expected;
            case "$neq": return actual !== expected;
            case "$in": return expected.includes(actual);
            case "$ilike": return typeof actual === 'string' && pattern!.test(actual);
            case "$gt": return actual != null && actual > expected;
            case "$gte": return actual != null && actual >= expected;
            case "$lt": return actual != null && actual < expected;
            case "$lte": return actual != null && actual <= expected;
          }
        };
      });
      const matches = (row: Record<string, unknown>) => predicates.every(predicate => predicate(row));
      if (request.action === "select") {
        let result = rows.filter(matches);
        if (request.order) result.sort((a, b) => {
          const left = a[request.order!.field] as any, right = b[request.order!.field] as any;
          return (left === right ? 0 : left == null ? -1 : right == null ? 1 : left < right ? -1 : 1) * (request.order!.ascending ? 1 : -1);
        });
        if (request.offset != null) result = result.slice(request.offset);
        if (request.limit != null) result = result.slice(0, request.limit);
        if (request.select && !request.select.includes('*')) result = result.map(row => Object.fromEntries(request.select!.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
        return { rows: result as T[] };
      }
      if (request.action === "insert") {
        const values = Array.isArray(request.values) ? request.values : [request.values];
        const created = values.map((value: unknown) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...(value as object) }));
        rows.push(...created); save(request.table); return { rows: created as T[] };
      }
      const affected = rows.filter(matches);
      if (request.action === "update") affected.forEach((row) => Object.assign(row, request.values, { updated_at: new Date().toISOString() }));
      if (request.action === "delete") affected.forEach((row) => rows.splice(rows.indexOf(row), 1));
      save(request.table); return { rows: affected as T[] };
    },
  };
  return createAdapter(driver);
}
