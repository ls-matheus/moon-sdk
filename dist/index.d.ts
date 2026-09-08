import type { DatabaseAdapter, MoonClient } from "./types.js";
import type { SupabaseClient } from '@supabase/supabase-js';
export type * from "./types.js";
export * from "./dictionaries.js";
export * from "./adapters.js";
export * from "./browser.js";
export declare function createClient(database: DatabaseAdapter | SupabaseClient): MoonClient;
