import { dictionaries } from "./dictionaries.js";
const missingAuth = new Proxy({}, {
    get() { return () => Promise.reject(new Error("No authentication provider configured for this adapter")); },
});
function makeQuery(driver, dictionary, table, state, action, values) {
    const request = { ...state, table, action, values, filters: state.filters ?? [] };
    const query = {
        select(columns = "*") { request.select = columns.split(",").map((column) => column.trim()); return query; },
        order(column, options = {}) { request.order = { field: column, ascending: options.ascending ?? true }; return query; },
        limit(count) { request.limit = count; return query; },
        range(from, to) { request.offset = from; request.limit = to - from + 1; return query; },
        eq(column, value) { request.filters.push({ field: column, operator: "$eq", value }); return query; },
        where(column, operator, value) { request.filters.push({ field: column, operator, value }); return query; },
        then(onfulfilled) {
            const result = driver.execute(request)
                .then(({ rows }) => ({ data: rows, error: null }))
                .catch((error) => ({ data: null, error: error instanceof Error ? error : new Error(String(error)) }));
            return result.then(onfulfilled);
        },
    };
    // Keep the dictionary attached for adapters that need provider-specific behavior.
    void dictionary;
    return query;
}
export function createAdapter(driver) {
    const dictionary = dictionaries[driver.provider];
    return {
        from(table) {
            const normalized = dictionary.tableName(table);
            const state = { filters: [] };
            return {
                select(columns = "*") { return makeQuery(driver, dictionary, normalized, state, "select").select(columns); },
                insert(values) { return makeQuery(driver, dictionary, normalized, state, "insert", values); },
                update(values) { return makeQuery(driver, dictionary, normalized, state, "update", values); },
                delete() { return makeQuery(driver, dictionary, normalized, state, "delete"); },
            };
        },
        auth: driver.auth ?? missingAuth,
    };
}
export function createSqlAdapter(executor, provider = "postgres") {
    const dictionary = dictionaries[provider];
    const driver = {
        provider,
        async execute(request) {
            const { table, select = ["*"], filters, order, limit, offset, action, values } = request;
            const columns = select.map((field) => field === "*" ? "*" : dictionary.quoteIdentifier(dictionary.columnName(field))).join(", ");
            const params = [];
            const where = filters.map(({ field, operator, value }) => {
                const sqlOperator = dictionary.operators[operator];
                if (!sqlOperator)
                    throw new Error(`Unsupported ${operator} operator for ${provider}`);
                params.push(value);
                return `${dictionary.quoteIdentifier(dictionary.columnName(field))} ${sqlOperator} ${dictionary.placeholders(params.length)}`;
            });
            let sql = `SELECT ${columns} FROM ${dictionary.quoteIdentifier(table)}`;
            if (where.length)
                sql += ` WHERE ${where.join(" AND ")}`;
            if (order)
                sql += ` ORDER BY ${dictionary.quoteIdentifier(dictionary.columnName(order.field))} ${order.ascending ? "ASC" : "DESC"}`;
            if (limit != null) {
                sql += ` LIMIT ${dictionary.placeholders(params.length + 1)}`;
                params.push(limit);
            }
            if (offset != null) {
                sql += ` OFFSET ${dictionary.placeholders(params.length + 1)}`;
                params.push(offset);
            }
            if (action === "insert" || action === "update" || action === "delete") {
                const data = (values ?? {});
                if (action === "insert") {
                    const items = Array.isArray(values) ? values : [data];
                    const inserted = [];
                    for (const item of items) {
                        const keys = Object.keys(item);
                        const insertValues = keys.map((key) => item[key]);
                        const start = params.length;
                        const insertSql = `INSERT INTO ${dictionary.quoteIdentifier(table)} (${keys.map((key) => dictionary.quoteIdentifier(dictionary.columnName(key))).join(", ")}) VALUES (${keys.map((_, index) => dictionary.placeholders(start + index + 1)).join(", ")})`;
                        const result = await executor.query(insertSql, insertValues);
                        inserted.push(...result.rows);
                    }
                    return { rows: inserted };
                }
                if (action === "update") {
                    const keys = Object.keys(data);
                    const updateParams = [...keys.map((key) => data[key]), ...filters.map((filter) => filter.value)];
                    const updateWhere = filters.map((filter, index) => `${dictionary.quoteIdentifier(dictionary.columnName(filter.field))} ${dictionary.operators[filter.operator]} ${dictionary.placeholders(keys.length + index + 1)}`);
                    const updateSql = `UPDATE ${dictionary.quoteIdentifier(table)} SET ${keys.map((key, index) => `${dictionary.quoteIdentifier(dictionary.columnName(key))} = ${dictionary.placeholders(index + 1)}`).join(", ")}${updateWhere.length ? ` WHERE ${updateWhere.join(" AND ")}` : ""}`;
                    const result = await executor.query(updateSql, updateParams);
                    return { rows: result.rows };
                }
                const deleteParams = filters.map((filter) => filter.value);
                const deleteWhere = filters.map((filter, index) => `${dictionary.quoteIdentifier(dictionary.columnName(filter.field))} ${dictionary.operators[filter.operator]} ${dictionary.placeholders(index + 1)}`);
                const deleteSql = `DELETE FROM ${dictionary.quoteIdentifier(table)}${deleteWhere.length ? ` WHERE ${deleteWhere.join(" AND ")}` : ""}`;
                const result = await executor.query(deleteSql, deleteParams);
                return { rows: result.rows };
            }
            const result = await executor.query(sql, params);
            return { rows: result.rows };
        },
    };
    return createAdapter(driver);
}
export function createFirebaseAdapter(firestore, auth) {
    const driver = {
        provider: "firebase",
        async execute(request) {
            const { table, select, filters, order, limit, offset, action, values } = request;
            let reference = firestore.collection(table);
            if (action === "select") {
                for (const filter of filters)
                    reference = reference.where(filter.field, dictionaries.firebase.operators[filter.operator], filter.value);
                if (order)
                    reference = reference.orderBy(order.field, order.ascending ? "asc" : "desc");
                if (offset)
                    reference = reference.offset(offset);
                if (limit != null)
                    reference = reference.limit(limit);
                const snapshot = await reference.get();
                return { rows: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
            }
            if (action === "insert") {
                const items = Array.isArray(values) ? values : [values];
                const rows = [];
                for (const item of items) {
                    const ref = await reference.add(item);
                    rows.push({ id: ref.id, ...item });
                }
                return { rows };
            }
            throw new Error(`Firebase adapter requires an explicit document id for ${action}`);
        },
    };
    return createAdapter({ ...driver, auth });
}
export function createSupabaseAdapter(client) {
    return client;
}
/** Local-only adapter for development and previews when no remote database is configured. */
export function createMemoryAdapter(storage) {
    const memory = new Map();
    const read = (table) => {
        if (!memory.has(table)) {
            let rows = [];
            try {
                rows = JSON.parse(storage?.getItem(`moon:table:${table}`) || "[]");
            }
            catch { /* use empty table */ }
            memory.set(table, Array.isArray(rows) ? rows : []);
        }
        return memory.get(table);
    };
    const save = (table) => storage?.setItem(`moon:table:${table}`, JSON.stringify(read(table)));
    const localUserKey = "moon:local-user";
    const auth = {
        async getSession() { const user = await this.getUser(); return { session: user.user ? { user: user.user, access_token: "moon-local-session" } : null }; },
        async getUser() { let user = null; try {
            user = JSON.parse(storage?.getItem(localUserKey) || "null");
        }
        catch { /* empty session */ } return { user: user }; },
        async signInWithPassword({ email }) { const user = { id: `local-${encodeURIComponent(email)}`, email }; storage?.setItem(localUserKey, JSON.stringify(user)); return { user, session: { user, access_token: "moon-local-session" } }; },
        async signUp(credentials) { return this.signInWithPassword(credentials); },
        async signOut() { storage?.removeItem(localUserKey); },
        async updateUser(attributes) { const current = (await this.getUser()).user || {}; const user = { ...current, ...attributes }; storage?.setItem(localUserKey, JSON.stringify(user)); return { user: user }; },
        async resetPasswordForEmail() { },
        async signInWithOAuth() { throw new Error("OAuth não está disponível no modo local."); },
        async verifyOtp() { }, async resend() { },
        onAuthStateChange() { return { unsubscribe() { } }; },
    };
    const driver = {
        provider: "sql",
        auth,
        async execute(request) {
            const rows = read(request.table);
            const matches = (row) => request.filters.every((filter) => filter.operator === "$eq" ? row[filter.field] === filter.value : filter.operator === "$is" ? row[filter.field] === filter.value : true);
            if (request.action === "select") {
                let result = rows.filter(matches);
                if (request.order)
                    result.sort((a, b) => String(a[request.order.field] ?? "").localeCompare(String(b[request.order.field] ?? "")) * (request.order.ascending ? 1 : -1));
                if (request.offset != null)
                    result = result.slice(request.offset);
                if (request.limit != null)
                    result = result.slice(0, request.limit);
                return { rows: result };
            }
            if (request.action === "insert") {
                const values = Array.isArray(request.values) ? request.values : [request.values];
                const created = values.map((value) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...value }));
                rows.push(...created);
                save(request.table);
                return { rows: created };
            }
            const affected = rows.filter(matches);
            if (request.action === "update")
                affected.forEach((row) => Object.assign(row, request.values, { updated_at: new Date().toISOString() }));
            if (request.action === "delete")
                affected.forEach((row) => rows.splice(rows.indexOf(row), 1));
            save(request.table);
            return { rows: affected };
        },
    };
    return createAdapter(driver);
}
