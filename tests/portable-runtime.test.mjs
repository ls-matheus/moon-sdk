import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, resolveConfig } from 'vite';
import { installPortableRuntime } from '../bin/runtime-vite.mjs';
import { createPortableClient } from '../bin/portable-client.mjs';
import { createClient, createMemoryAdapter } from '../dist/index.js';
import { createFetchWithAuth, createFunctionFetch, createFunctionInvoker } from '../bin/client-bridge.mjs';
import { inspectProject } from '../bin/project-inspect.mjs';
import { reference, catalog } from '../bin/compatibility-catalog.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const put = (dir, file, content) => { const path = resolve(dir, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };

test('app exportado compila sem Base44 preservando configuração Vite e imports fora do cliente padrão', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(root, '.moon-fixture-'));
  try {
    put(dir, 'package.json', JSON.stringify({ type: 'module', dependencies: { '@base44/sdk': '0.8.48' }, devDependencies: { vite: '8.2.2', '@base44/vite-plugin': '*' } }));
    put(dir, 'index.html', '<div id="root"></div><script type="module" src="/src/main.js"></script>');
    put(dir, '.env.local', 'VITE_MOON_PROVIDER=none');
    const entry = `import { createClient as factory } from '@base44/sdk';
      import { createAxiosClient } from '@base44/sdk/dist/utils/axios-client';
      import message from 'virtual:message';
      const client = factory({appId:'personal'});
      document.getElementById('root').textContent = message;
      window.client = client;
      window.settings = createAxiosClient({baseURL:'https://base44.app/api/apps'}).get('/public-settings/by-id/personal');`;
    put(dir, 'src/main.js', entry);
    put(dir, 'vite.config.mjs', `import {defineConfig} from 'vite';
      import base44 from '@base44/vite-plugin';
      export default defineConfig(async () => ({ base:'/portfolio/', define:{__PRESERVED__:'true'},
        resolve:{alias:{'@moon/sdk':${JSON.stringify(resolve(root, 'dist/index.js'))}, custom:'kept'}},
        build:{outDir:'custom-dist'}, server:{proxy:{'/other':'http://127.0.0.1:9999'}},
        plugins:[base44(), {name:'custom-plugin',resolveId(id){if(id==='virtual:message')return '\\0message'},load(id){if(id==='\\0message')return 'export default "preserved"'}}]
      }));`);
    installPortableRuntime(dir, { provider: 'none', backendPort: 9191, frontendPort: 6161 });
    assert.equal(readFileSync(resolve(dir, 'src/main.js'), 'utf8'), entry);
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json')));
    assert.equal(pkg.dependencies['@base44/sdk'], undefined);
    assert.equal(pkg.devDependencies['@base44/vite-plugin'], undefined);
    const config = await resolveConfig({ root: dir, logLevel: 'silent' }, 'build');
    assert.equal(config.base, '/portfolio/');
    assert.equal(config.build.outDir, 'custom-dist');
    assert.equal(config.server.proxy['/other'], 'http://127.0.0.1:9999');
    assert.equal(config.server.proxy['/api'], 'http://127.0.0.1:9191');
    const result = await build({ root: dir, logLevel: 'silent', build: { write: false } });
    const chunks = result.output.filter(item => item.type === 'chunk');
    const moduleIds = chunks.flatMap(chunk => Object.keys(chunk.modules));
    assert.ok(moduleIds.some(id => id.endsWith('moon-base44-sdk.mjs')));
    assert.ok(moduleIds.every(id => !id.includes('node_modules/@base44/')));
    assert.ok(chunks.some(chunk => chunk.code.includes('preserved')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('facade mantém CRUD, configurações locais e adaptadores explícitos; não simula serviços ausentes', async () => {
  const client = createPortableClient(createClient(createMemoryAdapter()), { appId: 'personal', adapters: { integrations: { Core: { UploadFile: async ({ file }) => ({ file_url: '/files/' + file.name }) } } } });
  const note = await client.entities.Note.create({ title: 'a' });
  assert.equal((await client.entities.Note.get(note.id)).title, 'a');
  assert.deepEqual(await client.app.getPublicSettings(), { id: 'personal', public_settings: 'public_without_login' });
  assert.deepEqual(await client.integrations.Core.UploadFile({ file: { name: 'cover.png' } }), { file_url: '/files/cover.png' });
  assert.throws(() => client.integrations.Core.SendEmail({ to: 'test' }), error => error.code === 'MOON_UNSUPPORTED' && error.feature === 'integrations.Core.SendEmail');
  assert.throws(() => client.agents.createConversation(), /adaptador local/);
  assert.throws(() => client.entities.Note.subscribe(() => {}), /entities.Note.subscribe/);
  assert.equal(await Promise.resolve(client), client);
  await assert.rejects(client.auth.me(), error => error.status === 401);
  const entries = new Map();
  const logged = createPortableClient(createClient(createMemoryAdapter()), { appId: 'personal', activityStorage: { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) } });
  await logged.appLogs.logUserInApp('Home');
  assert.equal(JSON.parse(entries.get('moon:activity:personal'))[0].page_name, 'Home');
});

test('fetchWithAuth preserva headers explícitos e não vaza token para outra origem', async () => {
  const fetch = createFetchWithAuth({ getAccessToken: async () => 'local-token' }, async (path, init) => { assert.equal(path, '/api/own'); assert.equal(init.headers.get('authorization'), 'custom'); return Response.json({ ok: true }); });
  assert.equal((await fetch('/api/own', { headers: { Authorization: 'custom' } })).status, 200);
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/\t/evil.test', ' /\n/evil.test']) await assert.rejects(fetch(path), /própria aplicação/);
  const fn = createFunctionFetch({}, async (path, init) => { assert.equal(path, '/api/functions/report?day=1'); assert.equal(init.method, 'GET'); return new Response('csv'); });
  assert.equal(await (await fn('report?day=1', { method: 'GET' })).text(), 'csv');
  const invoke = createFunctionInvoker({}, async (_path, init) => { assert.ok(init.body instanceof FormData); assert.equal(init.headers['Content-Type'], undefined); return Response.json({ ok: true }); });
  await invoke('upload', { file: new File(['body'], 'a.txt') });
});

test('inspeção usa contrato oficial e encontra aliases, métodos extraídos e recursos não adaptados', () => {
  const dir = mkdtempSync(join(root, '.moon-fixture-'));
  try {
    put(dir, 'src/api/client.js', `import {createClient as make} from '@base44/sdk'; export const api = make({appId:'a'});`);
    put(dir, 'src/main.js', `import {api} from './api/client';
      const notes = api.entities.Note; const {UploadFile: upload} = api.integrations.Core;
      notes.list(); upload({}); api.agents.createConversation({}); api.entities.Note.filter({rank:{$regex:'x'}});`);
    const report = inspectProject(dir);
    assert.equal(report.referenceVersion, '0.8.48');
    assert.equal(report.verdict, 'not_verified');
    assert.ok(report.calls.some(call => call.feature === 'entities.*.list'));
    assert.ok(report.errors.some(error => error.includes('integrations.Core.UploadFile')));
    assert.ok(report.errors.some(error => error.includes('agents.createConversation')));
    assert.ok(report.warnings.some(error => error.includes('$regex')));
    assert.ok(Object.keys(catalog).length > 60);
    assert.equal(reference.interfaces.EntityHandler.members.length, 12);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
