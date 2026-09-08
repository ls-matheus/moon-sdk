import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP de IA verifica sessão e executa InvokeLLM com schema sem Base44', { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'moon-ai-http-'));
  let aiCalls = 0;
  const upstream = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/v1/user') {
      res.statusCode = req.headers.authorization === 'Bearer valid-session' ? 200 : 401;
      res.end(JSON.stringify({ id: 'user-one' }));
      return;
    }
    aiCalls++;
    assert.equal(req.url, '/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-ai-key');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }));
  });
  let child;
  try {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    writeFileSync(join(directory, 'moon.config.json'), JSON.stringify({ provider: 'supabase', localFunctions: { echo: { access: 'public' }, upload: { access: 'public' }, empty: { access: 'public' } } }));
    mkdirSync(join(directory, 'functions'));
    writeFileSync(join(directory, 'functions/echo.ts'), `Deno.serve(async req => new Response(req.method + ':' + new URL(req.url).searchParams.get('q') + ':' + req.headers.get('x-app'), {headers:{'Content-Type':'text/plain','X-Result':'preserved'}}));`);
    writeFileSync(join(directory, 'functions/upload.ts'), `export default async req => { const form=await req.formData(); const file=form.get('file'); return Response.json({name:file.name,text:await file.text()}); };`);
    writeFileSync(join(directory, 'functions/empty.ts'), `export default () => new Response(null, {status:204});`);
    child = spawn(process.execPath, [fileURLToPath(new URL('../bin/local-server.mjs', import.meta.url))], {
      cwd: directory,
      env: { ...process.env, MOON_BACKEND_PORT: '0', MOON_AI_PROVIDER: 'openai', MOON_AI_API_KEY: 'test-ai-key',
        MOON_AI_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, MOON_SUPABASE_URL: `http://127.0.0.1:${upstream.address().port}`, MOON_SUPABASE_ANON_KEY: 'public-key' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend não iniciou')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Backend encerrou: ' + code)); });
      child.stdout.on('data', chunk => {
        const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}/api/ai/invoke`); }
      });
    });
    const body = JSON.stringify({ prompt: 'Responda', response_json_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } });
    const unauthenticated = await fetch(endpoint, { method: 'POST', body });
    assert.equal(unauthenticated.status, 401);
    assert.equal(aiCalls, 0);
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer valid-session', 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { answer: 'ok' });
    assert.equal(aiCalls, 1);
    const functionUrl = endpoint.replace('/api/ai/invoke', '/api/functions/');
    const echo = await fetch(functionUrl + 'echo?q=ol%C3%A1', { headers: { 'X-App': 'ok' } });
    assert.equal(echo.status, 200);
    assert.equal(echo.headers.get('x-result'), 'preserved');
    assert.equal(await echo.text(), 'GET:olá:ok');
    const file = new FormData(); file.append('file', new File(['conteúdo'], 'note.txt'));
    const uploaded = await fetch(functionUrl + 'upload', { method: 'POST', body: file });
    assert.equal(uploaded.status, 200);
    assert.deepEqual(await uploaded.json(), { name: 'note.txt', text: 'conteúdo' });
    const empty = await fetch(functionUrl + 'empty', { method: 'POST' });
    assert.equal(empty.status, 204); assert.equal(await empty.text(), '');
    const missing = await fetch(functionUrl + 'missing');
    assert.equal(missing.status, 401);
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
