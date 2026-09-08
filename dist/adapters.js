import { dictionaries } from "./dictionaries.js";
import { createSupabaseAuthAdapter } from './supabase-auth.js';
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
export function createSqlAdapter(executor, provider = "postgres", schema) {
    if (provider === "sql")
        throw new Error("Escolha um dialeto concreto: postgres ou mysql.");
    const dictionary = dictionaries[provider];
    const quote = (field) => dictionary.quoteIdentifier(dictionary.columnName(field));
    const normalize = (value) => value && typeof value === "object" ? JSON.stringify(value) : value;
    const timestamp = () => provider === "mysql" ? new Date().toISOString().replace("T", " ").replace("Z", "") : new Date().toISOString();
    const driver = {
        provider,
        async execute(request) {
            const table = dictionary.quoteIdentifier(request.table);
            const params = [];
            const bind = (value) => { params.push(normalize(value)); return dictionary.placeholders(params.length); };
            const conditions = () => request.filters.map(({ field, operator, value }) => {
                const column = quote(field);
                if (operator === "$in") {
                    if (!Array.isArray(value))
                        throw new Error("$in exige uma lista.");
                    return value.length ? column + " IN (" + value.map(bind).join(", ") + ")" : "1 = 0";
                }
                if (value === null && ["$eq", "$is", "$neq"].includes(operator))
                    return column + (operator === "$neq" ? " IS NOT NULL" : " IS NULL");
                if (operator === "$is" && typeof value !== "boolean")
                    throw new Error("$is aceita null ou boolean.");
                if (operator === "$ilike")
                    return provider === "mysql" ? "LOWER(" + column + ") LIKE LOWER(" + bind(value) + ")" : column + " ILIKE " + bind(value);
                const op = dictionary.operators[operator];
                if (!op)
                    throw new Error("Operador não suportado: " + operator);
                return column + " " + (operator === "$is" ? "=" : op) + " " + bind(value);
            }).join(" AND ");
            const projection = (request.select || ["*"]).map(field => field === "*" ? "*" : quote(field)).join(", ");
            const pagination = (value) => {
                if (value != null && (!Number.isSafeInteger(value) || value < 0))
                    throw new Error("Paginação deve ser um inteiro não negativo.");
                return value;
            };
            if (request.action === "select") {
                const where = conditions();
                let sql = "SELECT " + projection + " FROM " + table + (where ? " WHERE " + where : "");
                if (request.order)
                    sql += " ORDER BY " + quote(request.order.field) + (request.order.ascending ? " ASC" : " DESC");
                const limit = pagination(request.limit), offset = pagination(request.offset);
                if (limit != null)
                    sql += " LIMIT " + (provider === "mysql" ? String(limit) : bind(limit));
                else if (offset != null && provider === "mysql")
                    sql += " LIMIT 18446744073709551615";
                if (offset != null)
                    sql += " OFFSET " + (provider === "mysql" ? String(offset) : bind(offset));
                return executor.query(sql, params);
            }
            if (request.action === "insert") {
                const values = Array.isArray(request.values) ? request.values : [request.values];
                if (!values.length)
                    return { rows: [] };
                const insert = async (connection) => {
                    const rows = [];
                    for (const value of values) {
                        if (!value || typeof value !== "object" || Array.isArray(value))
                            throw new Error("Registro inválido.");
                        const record = { id: crypto.randomUUID(), created_at: timestamp(), updated_at: timestamp(), ...value };
                        const keys = Object.keys(record);
                        const parameters = keys.map(k => normalize(record[k]));
                        const sql = "INSERT INTO " + table + " (" + keys.map(quote).join(", ") + ") VALUES (" + keys.map((_, i) => dictionary.placeholders(i + 1)).join(", ") + ")";
                        const result = await connection.query(sql + (provider === "postgres" ? " RETURNING " + projection : ""), parameters);
                        if (provider === "postgres")
                            rows.push(...result.rows);
                        else
                            rows.push(...(await connection.query("SELECT " + projection + " FROM " + table + " WHERE " + quote("id") + " = ?", [record.id])).rows);
                    }
                    return { rows };
                };
                if (executor.transaction)
                    return executor.transaction(insert);
                if (provider === "mysql" || values.length > 1)
                    throw new Error("O executor precisa oferecer transaction para esta gravação atômica.");
                return insert(executor);
            }
            if (!request.filters.length)
                throw new Error("Atualização/exclusão exige filtro explícito.");
            let sql;
            if (request.action === "update") {
                const value = request.values;
                if (!value || Array.isArray(value) || "id" in value)
                    throw new Error("Atualização inválida; id é imutável.");
                const record = { ...value, updated_at: timestamp() };
                sql = "UPDATE " + table + " SET " + Object.entries(record).map(([k, v]) => quote(k) + " = " + bind(v)).join(", ");
            }
            else
                sql = "DELETE FROM " + table;
            const filterStart = params.length;
            const where = conditions();
            sql += " WHERE " + where;
            if (provider === "postgres")
                return executor.query(sql + " RETURNING " + projection, params);
            if (!executor.transaction)
                throw new Error("MySQL precisa de um executor com transaction para retornar registros com consistência.");
            return executor.transaction(async (connection) => {
                const selected = await connection.query("SELECT * FROM " + table + " WHERE " + where + " FOR UPDATE", params.slice(filterStart));
                await connection.query(sql, params);
                if (request.action === "delete" || !selected.rows.length)
                    return { rows: selected.rows };
                const ids = selected.rows.map(row => row.id);
                return connection.query("SELECT " + projection + " FROM " + table + " WHERE " + quote("id") + " IN (" + ids.map(() => "?").join(", ") + ")", ids);
            });
        },
    };
    return createAdapter({
        ...driver,
        async execute(request) {
            const result = await driver.execute(request);
            const definition = Object.entries(schema?.entities || {}).find(([name]) => dictionary.tableName(name) === request.table)?.[1];
            return { rows: result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
                    const type = definition?.fields[key]?.type;
                    if (value == null)
                        return [key, value];
                    if (value instanceof Date)
                        return [key, value.toISOString()];
                    if (type === "boolean")
                        return [key, Boolean(value)];
                    if (type === "json" && typeof value === "string")
                        return [key, JSON.parse(value)];
                    if (type === "datetime" && typeof value === "string")
                        return [key, new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z").toISOString()];
                    return [key, value];
                }))) };
        },
    });
}
/** Firestore compat/Admin-style client. Use authenticated client credentials for user access. */
export function createFirebaseAdapter(firestore, auth, scoped = false, publicTables = []) {
    return createAdapter({
        provider: "firebase", auth,
        async execute(request) {
            const collection = firestore.collection(request.table);
            const publicTable = publicTables.includes(request.table);
            if (publicTable && request.action !== 'select')
                throw new Error('Entidade pública permite apenas leitura.');
            const user = scoped && !publicTable ? (await auth.getUser()).user : null;
            if (scoped && !publicTable && !user)
                throw new Error("Login necessário.");
            if (request.action === "select") {
                let reference = user ? collection.where("user_id", "==", user.id) : collection;
                for (const filter of request.filters) {
                    const operator = dictionaries.firebase.operators[filter.operator];
                    if (!operator)
                        throw new Error("Operador Firestore não suportado: " + filter.operator);
                    reference = reference.where(filter.field, operator, filter.value);
                }
                if (request.order)
                    reference = reference.orderBy(request.order.field, request.order.ascending ? "asc" : "desc");
                if (request.limit != null && (!Number.isSafeInteger(request.limit) || request.limit < 0))
                    throw new Error("Limite inválido.");
                if (request.offset != null && (!Number.isSafeInteger(request.offset) || request.offset < 0))
                    throw new Error('Offset inválido.');
                if (request.limit === 0)
                    return { rows: [] };
                let skip = 0;
                if (request.offset) {
                    if (reference.offset)
                        reference = reference.offset(request.offset);
                    else
                        skip = request.offset;
                }
                if (request.limit != null)
                    reference = reference.limit(request.limit + skip);
                const snapshot = await reference.get();
                const rows = snapshot.docs.slice(skip).map((doc) => ({ ...doc.data(), id: doc.id }));
                return { rows: rows.map((row) => !request.select || request.select.includes("*") ? row : Object.fromEntries(request.select.map(key => [key, row[key]]))) };
            }
            if (request.action === "insert") {
                const values = Array.isArray(request.values) ? request.values : [request.values];
                if (values.length > 500)
                    throw new Error("Lote Firestore limitado a 500 documentos.");
                return firestore.runTransaction(async (transaction) => {
                    const records = values.map((value) => {
                        if (!value || typeof value !== "object" || Array.isArray(value))
                            throw new Error("Registro inválido.");
                        const id = value.id || crypto.randomUUID();
                        if (typeof id !== "string" || id.includes("/"))
                            throw new Error("ID inválido.");
                        return { ref: collection.doc(id), value: { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...value, id, ...(user ? { user_id: user.id } : {}) } };
                    });
                    const ids = new Set(records.map(record => record.value.id));
                    if (ids.size !== records.length)
                        throw new Error("IDs duplicados no lote.");
                    for (const record of records)
                        if ((await transaction.get(record.ref)).exists)
                            throw new Error("Registro já existe.");
                    for (const record of records)
                        transaction.set(record.ref, record.value);
                    return { rows: records.map(record => record.value) };
                });
            }
            const filter = request.filters[0];
            if (request.filters.length !== 1 || filter.field !== "id" || filter.operator !== "$eq" || typeof filter.value !== "string" || filter.value.includes("/"))
                throw new Error("Atualização/exclusão Firestore exige um único filtro id.");
            const ref = collection.doc(filter.value);
            return firestore.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(ref);
                if (!snapshot.exists)
                    return { rows: [] };
                const previous = { ...snapshot.data(), id: snapshot.id };
                if (user && previous.user_id !== user.id)
                    throw new Error("Acesso negado.");
                if (request.action === "delete") {
                    transaction.delete(ref);
                    return { rows: [previous] };
                }
                if (!request.values || typeof request.values !== "object" || Array.isArray(request.values) || "id" in request.values)
                    throw new Error("Atualização inválida.");
                const next = { ...previous, ...request.values, updated_at: new Date().toISOString(), ...(user ? { user_id: user.id } : {}) };
                transaction.update(ref, next);
                return { rows: [next] };
            });
        },
    });
}
export function createSupabaseAdapter(client) {
    return { from: client.from.bind(client), auth: createSupabaseAuthAdapter(client.auth) };
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
            const predicates = request.filters.map(({ field, operator, value }) => {
                if (operator === "$in" && !Array.isArray(value))
                    throw new Error("$in exige uma lista.");
                if (!["$eq", "$is", "$neq", "$gt", "$gte", "$lt", "$lte", "$in", "$ilike"].includes(operator))
                    throw new Error("Operador não suportado: " + operator);
                const pattern = operator === "$ilike" ? new RegExp('^' + String(value).split('').map(char => char === '%' ? '.*' : char === '_' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$', 'is') : undefined;
                return (row) => {
                    const actual = row[field];
                    const expected = value;
                    switch (operator) {
                        case "$eq":
                        case "$is": return actual === expected;
                        case "$neq": return actual !== expected;
                        case "$in": return expected.includes(actual);
                        case "$ilike": return typeof actual === 'string' && pattern.test(actual);
                        case "$gt": return actual != null && actual > expected;
                        case "$gte": return actual != null && actual >= expected;
                        case "$lt": return actual != null && actual < expected;
                        case "$lte": return actual != null && actual <= expected;
                    }
                };
            });
            const matches = (row) => predicates.every(predicate => predicate(row));
            if (request.action === "select") {
                let result = rows.filter(matches);
                if (request.order)
                    result.sort((a, b) => {
                        const left = a[request.order.field], right = b[request.order.field];
                        return (left === right ? 0 : left == null ? -1 : right == null ? 1 : left < right ? -1 : 1) * (request.order.ascending ? 1 : -1);
                    });
                if (request.offset != null)
                    result = result.slice(request.offset);
                if (request.limit != null)
                    result = result.slice(0, request.limit);
                if (request.select && !request.select.includes('*'))
                    result = result.map(row => Object.fromEntries(request.select.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
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
