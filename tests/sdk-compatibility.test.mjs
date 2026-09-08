import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createMemoryAdapter, createAdapter, createFirebaseAdapter } from '../dist/index.js';
import { createLLMInvoker } from '../bin/client-bridge.mjs';
import { createSupabaseAuthAdapter } from '../dist/supabase-auth.js';

test('API oficial de lotes cria e atualiza sem gravar id no payload de update', async () => {
  const sdk = createClient(createMemoryAdapter());
  const created = await sdk.entities.Note.bulkCreate([{ title: 'A' }, { title: 'B' }]);
  assert.equal(created.length, 2);
  const updated = await sdk.entities.Note.bulkUpdate(created.map(row => ({ id: row.id, title: row.title + '!' })));
  assert.deepEqual(updated.map(row => row.title), ['A!', 'B!']);
  assert.ok(updated.every(row => row.created_date));
  await assert.rejects(sdk.entities.Note.bulkUpdate([{ id: created[0].id, title: 'bad' }, { title: 'missing id' }]), /id/);
  assert.equal((await sdk.entities.Note.get(created[0].id)).title, 'A!');
  const calls = [];
  const client = createClient(createAdapter({ provider: 'postgres', async execute(request) {
    calls.push(request);
    return { rows: [{ id: 'one', ...request.values }] };
  } }));
  await client.entities.Note.bulkUpdate([{ id: 'one', title: 'new' }]);
  assert.deepEqual(calls[0].values, { title: 'new' });
  assert.deepEqual(calls[0].filters, [{ field: 'id', operator: '$eq', value: 'one' }]);
});

test('banco local aplica filtros, ordenação numérica e projeção', async () => {
  const sdk = createClient(createMemoryAdapter());
  await sdk.entities.Note.bulkCreate([{ rank: 2, title: 'Alpha' }, { rank: 10, title: 'Beta' }, { rank: 3, title: 'Alpine' }]);
  assert.deepEqual((await sdk.entities.Note.list('rank')).map(row => row.rank), [2, 3, 10]);
  assert.deepEqual(await sdk.entities.Note.filter({ rank: { $gte: 3, $lt: 10 } }, undefined, undefined, undefined, ['title']), [{ title: 'Alpine' }]);
  assert.equal((await sdk.entities.Note.filter({ rank: { $in: [2, 10] } })).length, 2);
  assert.equal((await sdk.entities.Note.filter({ title: { $ilike: 'AL%' } })).length, 2);
  assert.equal((await sdk.entities.Note.filter({ rank: { $ne: 2 } })).length, 2);
  await assert.rejects(sdk.entities.Note.filter({ rank: { $unknown: 3 } }), /Operador/);
});

test('cliente Supabase direto recebe operadores nativos e IS NULL', async () => {
  const calls = [];
  const query = { then: resolve => Promise.resolve(resolve({ data: [], error: null })) };
  for (const method of ['select', 'eq', 'neq', 'gt', 'in', 'is', 'not']) query[method] = (...args) => { calls.push([method, ...args]); return query; };
  const sdk = createClient({ from: () => query });
  await sdk.entities.Note.filter({ rank: { $gt: 2 }, title: { $ne: 'done' }, id: { $in: ['a'] }, deleted_at: null, archived_at: { $eq: null }, value: { $ne: null } });
  assert.deepEqual(calls, [['select', '*'], ['gt', 'rank', 2], ['neq', 'title', 'done'], ['in', 'id', ['a']], ['is', 'deleted_at', null], ['is', 'archived_at', null], ['not', 'value', 'is', null]]);
});

test('InvokeLLM envia sessão e preserva texto/JSON do contrato oficial', async () => {
  for (const result of ['resposta', { title: 'resposta' }]) {
    const invoke = createLLMInvoker({ getAccessToken: async () => 'session' }, async (url, options) => {
      assert.equal(url, '/api/ai/invoke');
      assert.equal(options.headers.Authorization, 'Bearer session');
      assert.deepEqual(JSON.parse(options.body), { prompt: 'Olá' });
      return Response.json(result);
    });
    assert.deepEqual(await invoke({ prompt: 'Olá' }), result);
  }
  const invoke = createLLMInvoker(null, async () => Response.json({ error: 'Entre na sua conta' }, { status: 401 }));
  await assert.rejects(invoke({ prompt: 'Olá' }), error => error.status === 401 && error.response.data.error === 'Entre na sua conta');
});

test('Firestore Web atende leitura pública e skip sem exigir offset do Admin SDK', async () => {
  const docs = [1, 2, 3, 4].map(id => ({ id: String(id), data: () => ({ title: 'n' + id }) }));
  let reads = 0, max;
  const collection = { limit(value) { max = value; return this; }, async get() { reads++; return { docs: docs.slice(0, max) }; } };
  const auth = { getUser: async () => { throw new Error('Não deve exigir login para tabela pública'); } };
  const sdk = createClient(createFirebaseAdapter({ collection: () => collection }, auth, true, ['note']));
  assert.deepEqual(await sdk.entities.Note.list(undefined, 2, 1, ['title']), [{ title: 'n2' }, { title: 'n3' }]);
  assert.deepEqual(await sdk.entities.Note.list(undefined, 0, 0), []);
  assert.equal(reads, 1);
  await assert.rejects(sdk.entities.Note.create({ title: 'proibido' }), /apenas leitura/);
});

test('Supabase adapta envelopes de auth e campos de perfil sem confiar no role editável', async () => {
  const calls = [];
  const user = { id: 'real-id', user_metadata: { id: 'forged', full_name: 'Ana', role: 'admin' }, app_metadata: { role: 'user' } };
  const raw = {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: { access_token: 'token', user } }, error: null }),
    updateUser: async attrs => { calls.push(attrs); return { data: { user: { ...user, user_metadata: attrs.data } }, error: null }; },
  };
  const client = createClient({ supabaseUrl: 'https://example.test', from() {}, auth: raw });
  assert.equal(await client.auth.isAuthenticated(), true);
  assert.equal((await client.auth.me()).full_name, 'Ana');
  assert.equal((await client.auth.me()).id, 'real-id');
  assert.equal((await client.auth.me()).role, 'user');
  assert.equal((await client.auth.updateMe({ full_name: 'Bia' })).full_name, 'Bia');
  assert.deepEqual(calls, [{ data: { full_name: 'Bia' } }]);
  const fail = createSupabaseAuthAdapter({ getUser: async () => ({ data: null, error: new Error('session expired') }) });
  await assert.rejects(fail.getUser(), /session expired/);
});
