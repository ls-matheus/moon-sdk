import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

// Generated execution snapshot: adapting the local provider must never rewrite shared source.
export function prepareLocalRuntime(directory) {
  const root = resolve(directory, ".moon");
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error(".moon não pode ser um link simbólico.");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const ignore = resolve(directory, ".gitignore");
  const content = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!content.split(/\r?\n/).includes(".moon/")) writeFileSync(ignore, content + "\n.moon/\n");
  const target = mkdtempSync(resolve(root, "runtime-"));
  const filter = source => {
      const parts = relative(directory, source).split(sep);
      if (parts.some(part => [".git", ".moon", "node_modules", "dist", "build", "coverage"].includes(part) || /^\.env(?:\.|$)/.test(part) || /\.(?:pem|key)$/.test(part) || /service[-_]?account/i.test(part))) return false;
      if (lstatSync(source).isSymbolicLink()) throw new Error("A cópia local não segue links simbólicos do aplicativo; revise: " + relative(directory, source));
      return !["moon.config.json", "moon/database-report.json", "base44/.app.jsonc"].includes(parts.join("/"));
  };
  for (const entry of readdirSync(directory)) {
    const source = resolve(directory, entry);
    if (filter(source)) cpSync(source, resolve(target, entry), { recursive: true, filter });
  }
  return target;
}
