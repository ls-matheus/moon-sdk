import type { DatabaseAdapter, MoonClient } from "./types.js";
export type * from "./types.js";
export * from "./dictionaries.js";
export * from "./adapters.js";
export declare function createClient(db: DatabaseAdapter): MoonClient;
