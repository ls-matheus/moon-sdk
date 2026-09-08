import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, createMemoryAdapter, createAdapter } from '../dist/index.js';
import { createLLMInvoker } from '../bin/client-bridge.mjs';

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
