import type { AuthAdapter, DatabaseAdapter, EntityQuery } from "./types.js";
import { dictionaries, type Provider, type ProviderDictionary } from "./dictionaries.js";

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
}

export function createSqlAdapter(executor: SqlExecutor, provider: "postgres" | "mysql" | "sql" = "postgres"): DatabaseAdapter {
  const dictionary = dictionaries[provider];
  const driver: DatabaseDriver = {
    provider,
    async execute<T>(request: QueryRequest) {
      const { table, select = ["*"], filters, order, limit, offset, action, values } = request;
      const columns = select.map((field) => field === "*" ? "*" : dictionary.quoteIdentifier(dictionary.columnName(field))).join(", ");
      const params: unknown[] = [];
      const where = filters.map(({ field, operator, value }) => {
        const sqlOperator = dictionary.operators[operator];
        if (!sqlOperator) throw new Error(`Unsupported ${operator} operator for ${provider}`);
        params.push(value);
        return `${dictionary.quoteIdentifier(dictionary.columnName(field))} ${sqlOperator} ${dictionary.placeholders(params.length)}`;
      });
      let sql = `SELECT ${columns} FROM ${dictionary.quoteIdentifier(table)}`;
      if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
      if (order) sql += ` ORDER BY ${dictionary.quoteIdentifier(dictionary.columnName(order.field))} ${order.ascending ? "ASC" : "DESC"}`;
      if (limit != null) { sql += ` LIMIT ${dictionary.placeholders(params.length + 1)}`; params.push(limit); }
      if (offset != null) { sql += ` OFFSET ${dictionary.placeholders(params.length + 1)}`; params.push(offset); }
      if (action === "insert" || action === "update" || action === "delete") {
        const data = (values ?? {}) as Record<string, unknown>;
        if (action === "insert") {
          const items = Array.isArray(values) ? values as Record<string, unknown>[] : [data];
          const inserted: T[] = [];
          for (const item of items) {
            const keys = Object.keys(item);
            const insertValues = keys.map((key) => item[key]);
            const start = params.length;
            const insertSql = `INSERT INTO ${dictionary.quoteIdentifier(table)} (${keys.map((key) => dictionary.quoteIdentifier(dictionary.columnName(key))).join(", ")}) VALUES (${keys.map((_, index) => dictionary.placeholders(start + index + 1)).join(", ")})`;
            const result = await executor.query<T>(insertSql, insertValues);
            inserted.push(...result.rows);
          }
          return { rows: inserted };
        }
        if (action === "update") {
          const keys = Object.keys(data);
          const updateParams = [...keys.map((key) => data[key]), ...filters.map((filter) => filter.value)];
          const updateWhere = filters.map((filter, index) => `${dictionary.quoteIdentifier(dictionary.columnName(filter.field))} ${dictionary.operators[filter.operator]} ${dictionary.placeholders(keys.length + index + 1)}`);
          const updateSql = `UPDATE ${dictionary.quoteIdentifier(table)} SET ${keys.map((key, index) => `${dictionary.quoteIdentifier(dictionary.columnName(key))} = ${dictionary.placeholders(index + 1)}`).join(", ")}${updateWhere.length ? ` WHERE ${updateWhere.join(" AND ")}` : ""}`;
          const result = await executor.query<T>(updateSql, updateParams);
          return { rows: result.rows };
        }
        const deleteParams = filters.map((filter) => filter.value);
        const deleteWhere = filters.map((filter, index) => `${dictionary.quoteIdentifier(dictionary.columnName(filter.field))} ${dictionary.operators[filter.operator]} ${dictionary.placeholders(index + 1)}`);
        const deleteSql = `DELETE FROM ${dictionary.quoteIdentifier(table)}${deleteWhere.length ? ` WHERE ${deleteWhere.join(" AND ")}` : ""}`;
        const result = await executor.query<T>(deleteSql, deleteParams);
        return { rows: result.rows };
      }
      const result = await executor.query<T>(sql, params);
      return { rows: result.rows };
    },
  };
  return createAdapter(driver);
}

export function createFirebaseAdapter(firestore: any, auth: DatabaseAdapter["auth"]): DatabaseAdapter {
  const driver: DatabaseDriver = {
    provider: "firebase",
    async execute<T>(request: QueryRequest) {
      const { table, select, filters, order, limit, offset, action, values } = request;
      let reference = firestore.collection(table);
      if (action === "select") {
        for (const filter of filters) reference = reference.where(filter.field, dictionaries.firebase.operators[filter.operator], filter.value);
        if (order) reference = reference.orderBy(order.field, order.ascending ? "asc" : "desc");
        if (offset) reference = reference.offset(offset);
        if (limit != null) reference = reference.limit(limit);
        const snapshot = await reference.get();
        return { rows: snapshot.docs.map((doc: any) => ({ id: doc.id, ...doc.data() })) as T[] };
      }
      if (action === "insert") {
        const items = Array.isArray(values) ? values : [values];
        const rows: T[] = [];
        for (const item of items) { const ref = await reference.add(item); rows.push({ id: ref.id, ...(item as object) } as T); }
        return { rows };
      }
      throw new Error(`Firebase adapter requires an explicit document id for ${action}`);
    },
  };
  return createAdapter({ ...driver, auth });
}

export function createSupabaseAdapter(client: DatabaseAdapter): DatabaseAdapter {
  return client;
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
      const matches = (row: Record<string, unknown>) => request.filters.every((filter) => filter.operator === "$eq" ? row[filter.field] === filter.value : filter.operator === "$is" ? row[filter.field] === filter.value : true);
      if (request.action === "select") {
        let result = rows.filter(matches);
        if (request.order) result.sort((a, b) => String(a[request.order!.field] ?? "").localeCompare(String(b[request.order!.field] ?? "")) * (request.order!.ascending ? 1 : -1));
        if (request.offset != null) result = result.slice(request.offset);
        if (request.limit != null) result = result.slice(0, request.limit);
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
