import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { discoverLoginUi } from './login-discovery.mjs';

// Only call on the generated runtime snapshot; shared app files stay unchanged.
export function installLoginBootstrap(directory, clientPath, provider, options = {}) {
  copyFileSync(new URL("./client-bridge.mjs", import.meta.url), resolve(directory, "src/moon-client-bridge.mjs"));
  if (provider === "none") return { mode: 'app', loginPath: null };
  const indexPath = resolve(directory, "index.html");
  const html = readFileSync(indexPath, "utf8");
  const script = html.match(/<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']([^"']+)["'])[^>]*>\s*<\/script>/i);
  if (!script || !/^\/?src\/[A-Za-z0-9_./-]+$/.test(script[1]) || script[1].includes("..")) throw new Error("Entrada frontend não reconhecida para proteger o login local.");
  const entry = "/" + script[1].replace(/^\//, "");
  const policy = discoverLoginUi(directory, entry, options);
  const context = resolve(directory, "src/lib/AuthContext.jsx");
  if (existsSync(context)) writeFileSync(context, readFileSync(context, "utf8").replace("if (appParams.token)", "if (await base44.auth.isAuthenticated())"));
  // Existing login UI owns navigation and session state; do not put another form in front.
  if (policy.mode === 'app') return policy;
  const client = "/" + relative(directory, clientPath).replaceAll("\\", "/");
  writeFileSync(resolve(directory, "src/moon-bootstrap.mjs"), `import { moonAuth } from ${JSON.stringify(client)};\nimport { ensureSession } from '/src/moon-client-bridge.mjs';\nensureSession(moonAuth).then(() => import(${JSON.stringify(entry)})).catch(() => { document.body.textContent = 'Não foi possível iniciar o aplicativo. Confira a configuração local.'; });\n`);
  writeFileSync(indexPath, html.replace(script[0], '<script type="module" src="/src/moon-bootstrap.mjs"></script>'));
  return policy;
}
