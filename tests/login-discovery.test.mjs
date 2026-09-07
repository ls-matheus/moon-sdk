import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverLoginUi } from '../bin/login-discovery.mjs';
import { installLoginBootstrap } from '../bin/runtime-auth.mjs';
import { createLoginRedirect } from '../bin/client-bridge.mjs';

function fixture(files, run) {
  const directory = mkdtempSync(join(tmpdir(), 'moon-login-discovery-'));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = join(directory, file);
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
    }
    return run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const login = `import {base44} from '@/api/base44Client'; export default function Login(){return <button onClick={()=>base44.auth.loginViaEmailPassword('email','password')}>Entrar</button>}`;
const html = '<div id="root"></div><script type="module" src="/src/main.jsx"></script>';

test('tela própria importada mantém HTML, JSX e uma única autenticação', () => fixture({
  'index.html': html,
  'src/main.jsx': `import Login from './pages/Login'; const app=<Route path="/login" element={<Login/>}/>;`,
  'src/pages/Login.jsx': login,
  'src/lib/AuthContext.jsx': 'if (appParams.token) {}',
}, directory => {
  assert.deepEqual(installLoginBootstrap(directory, join(directory, 'src/api/base44Client.js'), 'supabase'), { mode: 'app', loginPath: '/login' });
  assert.equal(readFileSync(join(directory, 'index.html'), 'utf8'), html);
  assert.equal(readFileSync(join(directory, 'src/pages/Login.jsx'), 'utf8'), login);
  assert.equal(existsSync(join(directory, 'src/moon-bootstrap.mjs')), false);
  assert.match(readFileSync(join(directory, 'src/lib/AuthContext.jsx'), 'utf8'), /base44.auth.isAuthenticated/);
}));

test('login órfão, comentários, strings e redirect hospedado não suprimem tela padrão', () => fixture({
  'src/main.jsx': `import {base44} from './api/base44Client'; // base44.auth.loginViaEmailPassword('a','b')\nconst text="base44.auth.loginWithProvider('google')"; base44.auth.redirectToLogin('/');`,
  'src/api/base44Client.js': `export const base44={auth:{loginViaEmailPassword: (e,p)=>sdk.auth.loginViaEmailPassword(e,p)}};`,
  'src/pages/Login.jsx': login,
}, directory => assert.equal(discoverLoginUi(directory, '/src/main.jsx').mode, 'moon')));

test('detecta OAuth carregado por lazy import e rotas PAGES do Base44', () => fixture({
  'src/main.jsx': `import {PAGES} from './pages.config';`,
  'src/pages.config.js': `const Login=lazy(()=>import('@/pages/Login')); export const PAGES={Login};`,
  'src/pages/Login.jsx': `export default ()=> <button onClick={()=>base44.auth.loginWithProvider('google')}>Google</button>;`,
}, directory => assert.deepEqual(discoverLoginUi(directory, '/src/main.jsx'), { mode: 'app', loginPath: '/Login' })));

test('login embutido é preservado sem inventar rota e configurações explícitas são validadas', () => fixture({
  'src/main.jsx': login,
}, directory => {
  assert.deepEqual(discoverLoginUi(directory, '/src/main.jsx'), { mode: 'app', loginPath: null });
  assert.deepEqual(discoverLoginUi(directory, '/src/main.jsx', { mode: 'app', loginPath: '/acesso' }), { mode: 'app', loginPath: '/acesso' });
  assert.equal(discoverLoginUi(directory, '/src/main.jsx', { mode: 'moon' }).mode, 'moon');
  for (const loginPath of ['https://evil.test', '//evil.test', '/\\evil', '/../login']) assert.throws(() => discoverLoginUi(directory, '/src/main.jsx', { loginPath }), /rota local/);
  assert.throws(() => discoverLoginUi(directory, '/src/main.jsx', { mode: 'invalid' }), /authUi.mode/);
}));

test('redirect usa rota própria sem recarregar em loop; padrão recarrega apenas quando solicitado', () => {
  const calls = [], location = { pathname: '/', assign: path => calls.push(path), reload: () => calls.push('reload') };
  const redirect = createLoginRedirect({ mode: 'app', loginPath: '/login' }, location);
  redirect(); assert.deepEqual(calls, ['/login']);
  location.pathname = '/login'; redirect(); assert.deepEqual(calls, ['/login']);
  assert.throws(createLoginRedirect({ mode: 'app', loginPath: null }, location), /authUi.loginPath/);
  createLoginRedirect({ mode: 'moon' }, location)(); assert.deepEqual(calls, ['/login', 'reload']);
});
