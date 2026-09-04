export type Json = string | number | boolean | null | Json[] | {
    [key: string]: Json;
};
export type QueryOperator = "$eq" | "$neq" | "$gt" | "$gte" | "$lt" | "$lte" | "$in" | "$ilike" | "$contains" | "$is";
export type FilterValue = Json | {
    [operator in QueryOperator]?: Json;
};
export type EntityFilter = Record<string, FilterValue>;
export interface User {
    id: string;
    email?: string;
    [key: string]: unknown;
}
export interface Session {
    access_token: string;
    user: User;
    [key: string]: unknown;
}
export interface AuthChange {
    event: string;
    session: Session | null;
}
export interface AuthAdapter {
    getSession(): Promise<{
        session: Session | null;
    }>;
    getUser(): Promise<{
        user: User | null;
    }>;
    signInWithPassword(credentials: {
        email: string;
        password: string;
    }): Promise<{
        session: Session | null;
        user: User | null;
    }>;
    signUp(credentials: {
        email: string;
        password: string;
    }): Promise<{
        session: Session | null;
        user: User | null;
    }>;
    signOut(): Promise<void>;
    updateUser(attributes: Record<string, unknown>): Promise<{
        user: User | null;
    }>;
    resetPasswordForEmail(email: string, options?: Record<string, unknown>): Promise<void>;
    signInWithOAuth?(options: {
        provider: string;
        options?: Record<string, unknown>;
    }): Promise<void>;
    verifyOtp?(params: Record<string, unknown>): Promise<void>;
    resend?(params: Record<string, unknown>): Promise<void>;
    onAuthStateChange(callback: (change: AuthChange) => void): {
        unsubscribe(): void;
    };
}
export interface EntityQuery<T> {
    select(columns?: string): EntityQuery<T>;
    order(column: string, options?: {
        ascending?: boolean;
    }): EntityQuery<T>;
    limit(count: number): EntityQuery<T>;
    range(from: number, to: number): EntityQuery<T>;
    eq(column: string, value: unknown): EntityQuery<T>;
    where?(column: string, operator: string, value: unknown): EntityQuery<T>;
    then<TResult = {
        data: T[] | null;
        error: Error | null;
    }>(onfulfilled?: ((value: {
        data: T[] | null;
        error: Error | null;
    }) => TResult | PromiseLike<TResult>) | null): Promise<TResult>;
}
export interface DatabaseAdapter {
    from<T = Record<string, unknown>>(table: string): {
        select(columns?: string): EntityQuery<T>;
        insert(values: Partial<T> | Partial<T>[]): EntityQuery<T>;
        update(values: Partial<T>): EntityQuery<T>;
        delete(): EntityQuery<T>;
    };
    auth: AuthAdapter;
}
export interface EntityHandler<T = Record<string, unknown>> {
    list(sort?: string, limit?: number, skip?: number, fields?: (keyof T)[]): Promise<Partial<T>[]>;
    filter(query: EntityFilter, sort?: string, limit?: number, skip?: number, fields?: (keyof T)[]): Promise<Partial<T>[]>;
    get(id: string): Promise<T>;
    create(data: Partial<T>): Promise<T>;
    update(id: string, data: Partial<T>): Promise<T>;
    delete(id: string): Promise<{
        success?: boolean;
        id?: string;
    }>;
}
export interface MoonClient {
    auth: {
        me(): Promise<User | null>;
        isAuthenticated(): Promise<boolean>;
        loginViaEmailPassword(email: string, password: string): Promise<{
            access_token?: string;
            user?: User | null;
        }>;
        register(params: {
            email: string;
            password: string;
        }): Promise<{
            access_token?: string;
            user?: User | null;
        }>;
        updateMe(data: Record<string, unknown>): Promise<User | null>;
        resetPasswordForEmail(email: string, options?: Record<string, unknown>): Promise<void>;
        logout(): Promise<void>;
        setToken(token: string): void;
        hasToken(): boolean;
        onChange(callback: (change: AuthChange) => void): {
            unsubscribe(): void;
        };
        loginWithProvider(provider: string, redirectTo: string): Promise<void>;
        verifyOtp(params: Record<string, unknown>): Promise<void>;
        resendOtp(params: Record<string, unknown>): Promise<void>;
    };
    entities: Record<string, EntityHandler>;
    cleanup(): void;
}
