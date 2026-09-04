import type { AuthAdapter, DatabaseAdapter } from "./types.js";
import { type Provider } from "./dictionaries.js";
export interface QueryRequest {
    table: string;
    select?: string[];
    filters: Array<{
        field: string;
        operator: string;
        value: unknown;
    }>;
    order?: {
        field: string;
        ascending: boolean;
    };
    limit?: number;
    offset?: number;
    action: "select" | "insert" | "update" | "delete";
    values?: unknown;
}
export interface DatabaseDriver {
    provider: Provider;
    auth?: AuthAdapter;
    execute<T = Record<string, unknown>>(request: QueryRequest): Promise<{
        rows: T[];
        count?: number;
    }>;
}
export declare function createAdapter(driver: DatabaseDriver): DatabaseAdapter;
export interface SqlExecutor {
    query<T = Record<string, unknown>>(sql: string, parameters: unknown[]): Promise<{
        rows: T[];
    }>;
}
export declare function createSqlAdapter(executor: SqlExecutor, provider?: "postgres" | "mysql" | "sql"): DatabaseAdapter;
export declare function createFirebaseAdapter(firestore: any, auth: DatabaseAdapter["auth"]): DatabaseAdapter;
export declare function createSupabaseAdapter(client: DatabaseAdapter): DatabaseAdapter;
/** Local-only adapter for development and previews when no remote database is configured. */
export declare function createMemoryAdapter(storage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}): DatabaseAdapter;
