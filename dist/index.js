export * from "./dictionaries.js";
export * from "./adapters.js";
function unwrap(query) {
    return query.then(({ data, error }) => {
        if (error)
            throw error;
        return data ?? [];
    });
}
function applyFilter(query, filter) {
    let result = query;
    for (const [column, value] of Object.entries(filter)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
            for (const [operator, operand] of Object.entries(value)) {
                if (operator === "$eq")
                    result = result.eq(column, operand);
                else if (operator === "$is")
                    result = result.eq(column, operand);
                else if (result.where)
                    result = result.where(column, operator, operand);
                else
                    throw new Error(`Filter operator ${operator} is not supported by this database adapter`);
            }
        }
        else {
            result = result.eq(column, value);
        }
    }
    return result;
}
function makeEntity(db, table) {
    const query = (fields) => db.from(table).select(fields?.join(",") || "*");
    return {
        async list(sort, limit, skip, fields) {
            let request = query(fields);
            if (sort)
                request = request.order(sort.replace(/^-/, ""), { ascending: !sort.startsWith("-") });
            if (limit != null)
                request = request.limit(limit);
            if (skip != null)
                request = request.range(skip, skip + (limit ?? 1000) - 1);
            return unwrap(request);
        },
        async filter(filter, sort, limit, skip, fields) {
            let request = applyFilter(query(fields), filter);
            if (sort)
                request = request.order(sort.replace(/^-/, ""), { ascending: !sort.startsWith("-") });
            if (limit != null)
                request = request.limit(limit);
            if (skip != null)
                request = request.range(skip, skip + (limit ?? 1000) - 1);
            return unwrap(request);
        },
        async get(id) {
            const rows = await unwrap(db.from(table).select("*").eq("id", id).limit(1));
            if (!rows[0])
                throw new Error(`${table} record ${id} was not found`);
            return rows[0];
        },
        async create(data) {
            const rows = await unwrap(db.from(table).insert(data).select("*"));
            return rows[0];
        },
        async update(id, data) {
            const rows = await unwrap(db.from(table).update(data).eq("id", id).select("*"));
            return rows[0];
        },
        async delete(id) {
            await unwrap(db.from(table).delete().eq("id", id));
            return { success: true, id };
        },
    };
}
function toAuthResult(session) {
    return { access_token: session?.access_token, user: session?.user ?? null };
}
export function createClient(db) {
    let token;
    const entities = new Proxy({}, {
        get(_target, name) {
            if (typeof name !== "string" || name === "then")
                return undefined;
            // Exported app entities conventionally use PascalCase; SQL tables use snake_case.
            const table = name.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`);
            return makeEntity(db, table);
        },
    });
    const auth = {
        async me() { return (await db.auth.getUser()).user; },
        async isAuthenticated() { return Boolean((await db.auth.getSession()).session); },
        async loginViaEmailPassword(email, password) {
            const result = await db.auth.signInWithPassword({ email, password });
            token = result.session?.access_token;
            return toAuthResult(result.session);
        },
        async register({ email, password }) {
            const result = await db.auth.signUp({ email, password });
            token = result.session?.access_token;
            return toAuthResult(result.session);
        },
        async updateMe(data) { return (await db.auth.updateUser(data)).user; },
        async resetPasswordForEmail(email, options) { await db.auth.resetPasswordForEmail(email, options); },
        async logout() { token = undefined; await db.auth.signOut(); },
        setToken(value) { token = value; },
        hasToken() { return Boolean(token); },
        onChange(callback) { return db.auth.onAuthStateChange(callback); },
        async loginWithProvider(provider, redirectTo) {
            if (!db.auth.signInWithOAuth)
                throw new Error("OAuth is not configured for this adapter");
            await db.auth.signInWithOAuth({ provider, options: { redirectTo } });
        },
        async verifyOtp(params) {
            if (!db.auth.verifyOtp)
                throw new Error("OTP is not configured for this adapter");
            await db.auth.verifyOtp(params);
        },
        async resendOtp(params) {
            if (!db.auth.resend)
                throw new Error("OTP is not configured for this adapter");
            await db.auth.resend(params);
        },
    };
    return { auth, entities, cleanup() { } };
}
