export type Provider = "supabase" | "firebase" | "postgres" | "mysql" | "sql";

export interface ProviderDictionary {
  provider: Provider;
  tableName(entity: string): string;
  columnName(field: string): string;
  operators: Record<string, string>;
  placeholders: (count: number) => string;
  quoteIdentifier(identifier: string): string;
  idField: string;
  timestamps: { created: string; updated: string };
}

const snakeCase = (value: string) => value.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`);
const safeIdentifier = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid database identifier: ${value}`);
  return value;
};

const relational = (provider: Provider, quote: string, placeholder: (n: number) => string): ProviderDictionary => ({
  provider,
  tableName: (entity) => safeIdentifier(snakeCase(entity)),
  columnName: (field) => safeIdentifier(snakeCase(field)),
  operators: { $eq: "=", $neq: "<>", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=", $in: "IN", $ilike: "ILIKE", $is: "IS" },
  placeholders: placeholder,
  quoteIdentifier: (identifier) => `${quote}${safeIdentifier(identifier)}${quote}`,
  idField: "id",
  timestamps: { created: "created_at", updated: "updated_at" },
});

export const dictionaries: Record<Provider, ProviderDictionary> = {
  supabase: relational("supabase", '"', (n) => `$${n}`),
  postgres: relational("postgres", '"', (n) => `$${n}`),
  mysql: relational("mysql", "`", () => "?"),
  sql: relational("sql", '"', (n) => `@p${n}`),
  firebase: {
    provider: "firebase",
    tableName: (entity) => entity,
    columnName: (field) => field,
    operators: { $eq: "==", $neq: "!=", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=", $in: "in", $arrayContains: "array-contains" },
    placeholders: (n) => `value${n}`,
    quoteIdentifier: (identifier) => identifier,
    idField: "id",
    timestamps: { created: "createdAt", updated: "updatedAt" },
  },
};

export function getDictionary(provider: Provider): ProviderDictionary {
  return dictionaries[provider];
}
