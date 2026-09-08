import "firebase/compat/auth";
import "firebase/compat/firestore";
export interface BrowserOptions {
    provider: "none" | "supabase" | "firebase" | "postgres" | "mysql";
    authProvider?: "supabase" | "firebase";
    supabaseUrl?: string;
    supabaseKey?: string;
    firebase?: Record<string, string>;
    publicEntities?: string[];
    endpoint?: string;
}
export declare function createBrowserClient(options: BrowserOptions): import("./types.js").MoonClient;
