import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import ts from 'typescript';
import { installLoginBootstrap } from './runtime-auth.mjs';

export function installPortableRuntime(directory, config) {
  const src = resolve(directory, 'src'); mkdirSync(src, { recursive: true });
  const packagePath = resolve(directory, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!pkg.dependencies?.vite && !pkg.devDependencies?.vite) throw new Error('Adaptação automática disponível para Vite. Este framework precisa de um adaptador de build.');
  const runtimePath = resolve(src, 'moon-runtime.mjs');
  for (const file of ['client-bridge.mjs', 'portable-client.mjs']) copyFileSync(new URL(file, import.meta.url), resolve(src, file));
  const loginUi = installLoginBootstrap(directory, runtimePath, config.provider, config.authUi);
  const adapterFile = ['moon.adapters.js', 'moon.adapters.ts'].find(file => existsSync(resolve(src, file)));
  writeFileSync(runtimePath, `import { createBrowserClient } from '@moon/sdk';
import { createPortableClient } from './portable-client.mjs';
${adapterFile ? `import adapters from './${adapterFile}';` : 'const adapters = {};'}
const sdk = createBrowserClient({
  provider: import.meta.env.VITE_MOON_PROVIDER,
  authProvider: import.meta.env.VITE_MOON_AUTH_PROVIDER,
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL, supabaseKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  firebase: { apiKey: import.meta.env.VITE_MOON_FIREBASE_API_KEY, projectId: import.meta.env.VITE_MOON_FIREBASE_PROJECT_ID, authDomain: import.meta.env.VITE_MOON_FIREBASE_AUTH_DOMAIN, appId: import.meta.env.VITE_MOON_FIREBASE_APP_ID },
  publicEntities: ${JSON.stringify(config.publicEntities || [])},
});
export const moonAuth = sdk.auth;
let client;
export function getClient(options = {}) {
  return client ||= createPortableClient(sdk, { appId: options.appId, provider: import.meta.env.VITE_MOON_PROVIDER, loginUi: ${JSON.stringify(loginUi)}, adapters, analytics: options.analytics || { enabled: false } });
}
`);
  writeFileSync(resolve(src, 'moon-base44-sdk.mjs'), `import { getClient } from './moon-runtime.mjs';
export const createClient = options => getClient(options);
export { Base44Error } from './portable-client.mjs';
import { MoonCompatibilityError } from './portable-client.mjs';
export function getAccessToken() { throw new MoonCompatibilityError('getAccessToken'); }
export function saveAccessToken() { throw new MoonCompatibilityError('saveAccessToken'); }
export function removeAccessToken() { throw new MoonCompatibilityError('removeAccessToken'); }
export function getLoginUrl() { throw new MoonCompatibilityError('getLoginUrl'); }
export function createClientFromRequest() { throw new Error('createClientFromRequest só está disponível em funções do backend local.'); }
`);
  writeFileSync(resolve(src, 'moon-axios-client.mjs'), `import { getClient } from './moon-runtime.mjs';
import { MoonCompatibilityError } from './portable-client.mjs';
export function createAxiosClient() { return { get(path) {
  if (/^\\/public-settings\\/by-id\\/[^/?]+$/.test(path)) return getClient().app.getPublicSettings();
  throw new MoonCompatibilityError('axios-client.get ' + path);
} }; }
`);
  const configPath = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.mts'].map(file => resolve(directory, file)).find(existsSync);
  let originalImport = 'const original = {};';
  if (configPath) {
    const source = readFileSync(configPath, 'utf8');
    const parsed = ts.createSourceFile(configPath, source, ts.ScriptTarget.Latest, true);
    if (parsed.parseDiagnostics.length) throw new Error('Configuração Vite inválida.');
    const edits = [];
    for (const node of parsed.statements) if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@base44/vite-plugin') {
      edits.push([node.moduleSpecifier.getStart(parsed), node.moduleSpecifier.end, JSON.stringify('./moon-vite-plugin.mjs')]);
    }
    let adapted = source;
    for (const [start, end, value] of edits.reverse()) adapted = adapted.slice(0, start) + value + adapted.slice(end);
    const backup = 'moon-original.' + basename(configPath);
    writeFileSync(resolve(directory, backup), adapted);
    originalImport = `import original from './${backup}';`;
  }
  writeFileSync(resolve(directory, 'moon-vite-plugin.mjs'), 'export const base44 = () => ({ name: "moon-replaced-base44-plugin" }); export default base44;\n');
  // Keep original build, CSS, plugins, aliases and unrelated proxies. Only SDK bindings change.
  writeFileSync(configPath || resolve(directory, 'vite.config.mjs'), `import path from 'node:path';
import { mergeConfig } from 'vite';
${originalImport}
export default async env => {
  const base = await (typeof original === 'function' ? original(env) : original);
  const aliases = Array.isArray(base?.resolve?.alias) ? base.resolve.alias : Object.entries(base?.resolve?.alias || {}).map(([find, replacement]) => ({find, replacement}));
  const merged = mergeConfig(base || {}, { server: { port: ${Number(config.frontendPort || 5173)}, strictPort: true, proxy: { '/api': 'http://127.0.0.1:${Number(config.backendPort || 8787)}' } } });
  merged.resolve ||= {};
  merged.resolve.alias = [
    { find: /^@base44\\/sdk$/, replacement: path.resolve(import.meta.dirname, 'src/moon-base44-sdk.mjs') },
    { find: /^@base44\\/sdk\\/dist\\/utils\\/axios-client(?:\\.js)?$/, replacement: path.resolve(import.meta.dirname, 'src/moon-axios-client.mjs') },
    ...aliases,
    ...(!aliases.some(item => item.find === '@') ? [{ find: '@', replacement: path.resolve(import.meta.dirname, 'src') }] : []),
  ];
  return merged;
};
`);
  for (const group of ['dependencies', 'devDependencies']) if (pkg[group]) {
    delete pkg[group]['@base44/sdk']; delete pkg[group]['@base44/vite-plugin'];
  }
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  return { loginUi, runtimePath };
}
