import test from 'node:test';
import assert from 'node:assert/strict';
import { withRuntimeAliases } from '../bin/runtime-env.mjs';

test('cada cópia local recebe o banco escolhido, sobrescrevendo seletores antigos', () => {
  for (const provider of ['none', 'supabase', 'firebase', 'postgres', 'mysql']) {
    const env = withRuntimeAliases(provider, { VITE_MOON_PROVIDER: 'stale', VITE_MOON_DEV_AUTH_BYPASS: 'stale' });
    assert.equal(env.VITE_MOON_PROVIDER, provider);
    assert.equal(env.VITE_MOON_DEV_AUTH_BYPASS, provider === 'none' ? 'true' : 'false');
    assert.equal(env.VITE_MOON_AUTH_PROVIDER, provider === 'firebase' ? 'firebase' : 'supabase');
  }
});

test('SQL preserva autenticação independente e só cria aliases públicos conhecidos', () => {
  const values = { MOON_AUTH_PROVIDER: 'firebase', MOON_FIREBASE_PROJECT_ID: 'test', MOON_FIREBASE_API_KEY: 'public', MOON_DATABASE_URL: 'private-db', MOON_AI_API_KEY: 'private-ai' };
  const env = withRuntimeAliases('postgres', values);
  assert.equal(env.VITE_MOON_AUTH_PROVIDER, 'firebase');
  assert.equal(env.VITE_MOON_FIREBASE_PROJECT_ID, 'test');
  assert.equal(env.VITE_MOON_FIREBASE_API_KEY, 'public');
  assert.ok(Object.entries(env).filter(([key]) => key.startsWith('VITE_')).every(([, value]) => !['private-db', 'private-ai'].includes(value)));
  const supabase = withRuntimeAliases('mysql', { MOON_SUPABASE_URL: 'https://example.test', MOON_SUPABASE_ANON_KEY: 'public' });
  assert.equal(supabase.VITE_SUPABASE_URL, 'https://example.test');
  assert.equal(supabase.VITE_SUPABASE_ANON_KEY, 'public');
});
