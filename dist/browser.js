import { createClient as supabaseClient } from "@supabase/supabase-js";
import firebaseCompat from "firebase/compat/app";
import "firebase/compat/auth";
import "firebase/compat/firestore";
import { createAdapter, createFirebaseAdapter, createMemoryAdapter } from "./adapters.js";
import { createClient } from "./index.js";
const firebase = firebaseCompat;
export function createBrowserClient(options) {
    if (options.provider === "none")
        return createClient(createMemoryAdapter(globalThis.localStorage));
    const authProvider = options.authProvider || (options.provider === "firebase" ? "firebase" : "supabase");
    let auth, supabase, firestore;
    if (authProvider === "supabase") {
        if (!options.supabaseUrl || !options.supabaseKey)
            throw new Error("Configure URL e chave pública do Supabase Auth.");
        supabase = supabaseClient(options.supabaseUrl, options.supabaseKey);
        const unwrap = async (result) => { const { data, error } = await result; if (error && error.name !== "AuthSessionMissingError")
            throw error; return data; };
        auth = {
            getSession: () => unwrap(supabase.auth.getSession()), getUser: () => unwrap(supabase.auth.getUser()),
            signInWithPassword: credentials => unwrap(supabase.auth.signInWithPassword(credentials)),
            signUp: credentials => unwrap(supabase.auth.signUp(credentials)), signOut: () => unwrap(supabase.auth.signOut()),
            updateUser: attributes => unwrap(supabase.auth.updateUser(attributes)),
            resetPasswordForEmail: (email, settings) => unwrap(supabase.auth.resetPasswordForEmail(email, settings)),
            signInWithOAuth: settings => unwrap(supabase.auth.signInWithOAuth(settings)),
            verifyOtp: params => unwrap(supabase.auth.verifyOtp(params)),
            resend: params => unwrap(supabase.auth.resend(params)),
            onAuthStateChange: callback => supabase.auth.onAuthStateChange((event, session) => callback({ event, session: session ? { access_token: session.access_token, user: { id: session.user.id, email: session.user.email } } : null })).data.subscription,
        };
    }
    else {
        if (!options.firebase?.projectId || !options.firebase.apiKey)
            throw new Error("Configure os dados públicos do Firebase Auth.");
        const name = "moon-" + options.firebase.projectId;
        const app = firebase.apps.find(app => app?.name === name) || firebase.initializeApp(options.firebase, name);
        const firebaseAuth = app.auth();
        firestore = app.firestore();
        const userData = (user) => user ? { id: user.uid, email: user.email || undefined } : null;
        const session = async () => {
            await new Promise(resolve => { const unsubscribe = firebaseAuth.onAuthStateChanged(() => { unsubscribe(); resolve(); }); });
            const user = firebaseAuth.currentUser;
            return user ? { user: userData(user), access_token: await user.getIdToken() } : null;
        };
        auth = {
            async getSession() { return { session: await session() }; },
            async getUser() { return { user: (await session())?.user || null }; },
            async signInWithPassword({ email, password }) { await firebaseAuth.signInWithEmailAndPassword(email, password); const result = await session(); return { user: result?.user || null, session: result }; },
            async signUp({ email, password }) { await firebaseAuth.createUserWithEmailAndPassword(email, password); const result = await session(); return { user: result?.user || null, session: result }; },
            signOut: () => firebaseAuth.signOut(),
            async updateUser(attributes) {
                if (!firebaseAuth.currentUser)
                    throw new Error("Login necessário.");
                const { displayName, photoURL } = attributes;
                await firebaseAuth.currentUser.updateProfile({ displayName: displayName, photoURL: photoURL });
                return { user: userData(firebaseAuth.currentUser) };
            },
            resetPasswordForEmail: email => firebaseAuth.sendPasswordResetEmail(email),
            onAuthStateChange(callback) { return { unsubscribe: firebaseAuth.onAuthStateChanged(async () => callback({ event: "AUTH_CHANGED", session: await session() })) }; },
        };
    }
    let database;
    if (options.provider === "firebase")
        database = createFirebaseAdapter(firestore, auth, true);
    else if (options.provider === "supabase") {
        database = createAdapter({ provider: "supabase", auth, async execute(request) {
                const publicTable = options.publicEntities?.some(entity => entity.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`) === request.table);
                const user = publicTable ? null : (await auth.getUser()).user;
                if (!user && !publicTable)
                    throw new Error("Login necessário.");
                if (publicTable) {
                    if (request.action !== "select")
                        throw new Error("Entidade pública permite apenas leitura.");
                    const session = (await auth.getSession()).session;
                    const response = await fetch(options.endpoint || "/api/database", {
                        method: "POST",
                        headers: { "Content-Type": "application/json", ...(session?.access_token ? { Authorization: "Bearer " + session.access_token } : {}) },
                        body: JSON.stringify(request),
                    });
                    const data = await response.json();
                    if (!response.ok)
                        throw new Error(data.error || "Falha no banco de dados.");
                    return { rows: data.rows };
                }
                let query = supabase.from(request.table);
                if (request.action === "insert") {
                    const values = Array.isArray(request.values) ? request.values : [request.values];
                    query = query.insert(values.map(value => ({ id: crypto.randomUUID(), ...value, user_id: user.id })));
                }
                else if (request.action === "update")
                    query = query.update({ ...request.values, updated_at: new Date().toISOString(), user_id: user?.id }).eq("user_id", user?.id);
                else if (request.action === "delete")
                    query = query.delete().eq("user_id", user?.id);
                else {
                    query = query.select((request.select || ["*"]).join(","));
                    if (!publicTable)
                        query = query.eq("user_id", user?.id);
                }
                const operators = { $eq: "eq", $neq: "neq", $gt: "gt", $gte: "gte", $lt: "lt", $lte: "lte", $in: "in", $is: "is", $ilike: "ilike" };
                for (const filter of request.filters) {
                    const operation = operators[filter.operator];
                    if (!operation)
                        throw new Error("Operador indisponível no Supabase.");
                    query = query[filter.value === null && filter.operator === "$eq" ? "is" : operation](filter.field, filter.value);
                }
                if (request.action !== "select")
                    query = query.select((request.select || ["*"]).join(","));
                if (request.order)
                    query = query.order(request.order.field, { ascending: request.order.ascending });
                if (request.limit != null)
                    query = query.limit(request.limit);
                if (request.offset != null)
                    query = query.range(request.offset, request.offset + (request.limit || 100) - 1);
                const { data, error } = await query;
                if (error)
                    throw error;
                return { rows: data };
            } });
    }
    else {
        database = createAdapter({ provider: options.provider, auth, async execute(request) {
                const publicTable = options.publicEntities?.some(entity => entity.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`) === request.table);
                const session = (await auth.getSession()).session;
                if (!session && !publicTable)
                    throw new Error("Login necessário.");
                if (publicTable && request.action !== "select")
                    throw new Error("Entidade pública permite apenas leitura.");
                const headers = { "Content-Type": "application/json" };
                if (session?.access_token)
                    headers.Authorization = "Bearer " + session.access_token;
                const response = await fetch(options.endpoint || "/api/database", {
                    method: "POST", headers,
                    body: JSON.stringify(request),
                });
                const data = await response.json();
                if (!response.ok)
                    throw new Error(data.error || "Falha no banco de dados.");
                return { rows: data.rows };
            } });
    }
    return createClient(database);
}
