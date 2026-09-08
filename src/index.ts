import type {
  AuthChange, DatabaseAdapter, EntityFilter, EntityHandler, EntityQuery,
  MoonClient, User,
} from "./types.js";

export type * from "./types.js";
export * from "./dictionaries.js";
export * from "./adapters.js";
export * from "./browser.js";

const canonicalField = (field: string) => field === "created_date" ? "created_at" : field === "updated_date" ? "updated_at" : field;

function unwrap<T>(query: EntityQuery<T>): Promise<T[]> {
  return query.then(({ data, error }) => {
    if (error) throw error;
    return (data ?? []).map(row => {
      if (!row || typeof row !== "object") return row;
      const record = row as Record<string, unknown>;
      return { ...record, ...(record.created_at !== undefined ? { created_date: record.created_at } : {}), ...(record.updated_at !== undefined ? { updated_date: record.updated_at } : {}) } as T;
    });
  });
}

function applyFilter<T>(query: EntityQuery<T>, filter: EntityFilter): EntityQuery<T> {
  let result = query;
  for (const [name, value] of Object.entries(filter)) {
    const column = canonicalField(name);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [operator, operand] of Object.entries(value)) {
        const normalized = operator === "$ne" ? "$neq" : operator;
        const methods: Record<string, string> = { $eq: "eq", $is: "is", $neq: "neq", $gt: "gt", $gte: "gte", $lt: "lt", $lte: "lte", $in: "in", $ilike: "ilike", $contains: "contains" };
        const method = operand === null && normalized === "$eq" ? "is" : methods[normalized];
        const direct = result as unknown as Record<string, ((...args: unknown[]) => EntityQuery<T>) | undefined>;
        if (normalized === "$neq" && operand === null && typeof direct.not === "function") result = direct.not(column, "is", null);
        else if (method && typeof direct[method] === "function") result = direct[method]!(column, operand);
        else if (result.where) result = result.where(column, normalized, operand);
        else if (normalized === "$is") result = result.eq(column, operand);
        else throw new Error(`Filter operator ${operator} is not supported by this database adapter`);
      }
    } else {
      const nullable = result as EntityQuery<T> & { is?: (column: string, value: null) => EntityQuery<T> };
      result = value === null && nullable.is ? nullable.is(column, null) : result.eq(column, value);
    }
  }
  return result;
}

function makeEntity<T>(db: DatabaseAdapter, table: string): EntityHandler<T> {
  const query = (fields?: (keyof T)[]) => db.from<T>(table).select(fields?.map(field => canonicalField(String(field))).join(",") || "*");
  return {
    async list(sort, limit, skip, fields) {
      let request = query(fields);
      if (sort) request = request.order(canonicalField(sort.replace(/^-/, "")), { ascending: !sort.startsWith("-") });
      if (limit != null) request = request.limit(limit);
      if (skip != null) request = request.range(skip, skip + (limit ?? 1000) - 1);
      return unwrap(request) as Promise<Partial<T>[]>;
    },
    async filter(filter, sort, limit, skip, fields) {
      let request = applyFilter(query(fields), filter);
      if (sort) request = request.order(canonicalField(sort.replace(/^-/, "")), { ascending: !sort.startsWith("-") });
      if (limit != null) request = request.limit(limit);
      if (skip != null) request = request.range(skip, skip + (limit ?? 1000) - 1);
      return unwrap(request) as Promise<Partial<T>[]>;
    },
    async get(id) {
      const rows = await unwrap(db.from<T>(table).select("*").eq("id", id).limit(1));
      if (!rows[0]) throw new Error(`${table} record ${id} was not found`);
      return rows[0];
    },
    async create(data) {
      const rows = await unwrap(db.from<T>(table).insert(data).select("*"));
      return rows[0];
    },
    async bulkCreate(data) {
      if (!Array.isArray(data)) throw new Error("bulkCreate exige uma lista de registros.");
      if (!data.length) return [];
      return unwrap(db.from<T>(table).insert(data).select("*"));
    },
    async bulkUpdate(data) {
      if (!Array.isArray(data) || data.some(row => !row || typeof row.id !== "string" || !row.id)) {
        throw new Error("bulkUpdate exige registros com id.");
      }
      const rows: T[] = [];
      for (const { id, ...values } of data) {
        const updated = await unwrap(db.from<T>(table).update(values as Partial<T>).eq("id", id).select("*"));
        if (!updated[0]) throw new Error(`${table} record ${id} was not found`);
        rows.push(updated[0]);
      }
      return rows;
    },
    async update(id, data) {
      const rows = await unwrap(db.from<T>(table).update(data).eq("id", id).select("*"));
      return rows[0];
    },
    async delete(id) {
      await unwrap(db.from<T>(table).delete().eq("id", id));
      return { success: true, id };
    },
  };
}

function toAuthResult(session: { access_token?: string; user?: User | null } | null) {
  return { access_token: session?.access_token, user: session?.user ?? null };
}

export function createClient(db: DatabaseAdapter): MoonClient {
  let token: string | undefined;
  const entities = new Proxy({}, {
    get(_target, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      // Exported app entities conventionally use PascalCase; SQL tables use snake_case.
      const table = name.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`);
      return makeEntity(db, table);
    },
  }) as Record<string, EntityHandler>;

  const auth = {
    async me() { return (await db.auth.getUser()).user; },
    async isAuthenticated() { return Boolean((await db.auth.getSession()).session); },
    async getAccessToken() { return (await db.auth.getSession()).session?.access_token; },
    async loginViaEmailPassword(email: string, password: string) {
      const result = await db.auth.signInWithPassword({ email, password });
      token = result.session?.access_token;
      return toAuthResult(result.session);
    },
    async register({ email, password, options }: { email: string; password: string; options?: Record<string, unknown> }) {
      const result = await db.auth.signUp({ email, password, options });
      token = result.session?.access_token;
      return toAuthResult(result.session);
    },
    async updateMe(data: Record<string, unknown>) { return (await db.auth.updateUser(data)).user; },
    async resetPasswordForEmail(email: string, options?: Record<string, unknown>) { await db.auth.resetPasswordForEmail(email, options); },
    async logout() { token = undefined; await db.auth.signOut(); },
    setToken(value: string) { token = value; },
    hasToken() { return Boolean(token); },
    onChange(callback: (change: AuthChange) => void) { return db.auth.onAuthStateChange(callback); },
    async loginWithProvider(provider: string, redirectTo: string) {
      if (!db.auth.signInWithOAuth) throw new Error("OAuth is not configured for this adapter");
      await db.auth.signInWithOAuth({ provider, options: { redirectTo } });
    },
    async verifyOtp(params: Record<string, unknown>) {
      if (!db.auth.verifyOtp) throw new Error("OTP is not configured for this adapter");
      await db.auth.verifyOtp(params);
    },
    async resendOtp(params: Record<string, unknown>) {
      if (!db.auth.resend) throw new Error("OTP is not configured for this adapter");
      await db.auth.resend(params);
    },
  };

  return { auth, entities, cleanup() {} };
}
