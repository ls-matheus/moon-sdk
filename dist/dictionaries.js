const snakeCase = (value) => value.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`);
const safeIdentifier = (value) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
        throw new Error(`Invalid database identifier: ${value}`);
    return value;
};
const relational = (provider, quote, placeholder) => ({
    provider,
    tableName: (entity) => safeIdentifier(snakeCase(entity)),
    columnName: (field) => safeIdentifier(snakeCase(field)),
    operators: { $eq: "=", $neq: "<>", $gt: ">", $gte: ">=", $lt: "<", $lte: "<=", $in: "IN", $ilike: "ILIKE", $is: "IS" },
    placeholders: placeholder,
    quoteIdentifier: (identifier) => `${quote}${safeIdentifier(identifier)}${quote}`,
    idField: "id",
    timestamps: { created: "created_at", updated: "updated_at" },
});
export const dictionaries = {
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
export function getDictionary(provider) {
    return dictionaries[provider];
}
