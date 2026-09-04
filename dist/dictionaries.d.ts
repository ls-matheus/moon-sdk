export type Provider = "supabase" | "firebase" | "postgres" | "mysql" | "sql";
export interface ProviderDictionary {
    provider: Provider;
    tableName(entity: string): string;
    columnName(field: string): string;
    operators: Record<string, string>;
    placeholders: (count: number) => string;
    quoteIdentifier(identifier: string): string;
    idField: string;
    timestamps: {
        created: string;
        updated: string;
    };
}
export declare const dictionaries: Record<Provider, ProviderDictionary>;
export declare function getDictionary(provider: Provider): ProviderDictionary;
