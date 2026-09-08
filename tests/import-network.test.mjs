import test from 'node:test';
import assert from 'node:assert/strict';
import { importNetworkEnv } from '../bin/import-network.mjs';

test('import connector uses Windows proxies without changing the parent environment', () => {
  const parent = { PATH: 'original' };
  const env = importNetworkEnv(parent, 'win32', () => ({ status: 0, stdout: '["http://proxy.test:3128/","http://npm-proxy.test:3128/"]' }));
  assert.equal(env.HTTPS_PROXY, 'http://proxy.test:3128/');
  assert.equal(env.npm_config_https_proxy, 'http://npm-proxy.test:3128/');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.deepEqual(parent, { PATH: 'original' });
});

test('explicit proxies and opt-outs are preserved; unavailable discovery keeps direct access', () => {
  const env = importNetworkEnv({ HTTPS_PROXY: 'http://custom.test', NODE_USE_ENV_PROXY: '0', NO_PROXY: 'localhost' }, 'win32', () => assert.fail('explicit proxy must not be probed'));
  assert.equal(env.HTTPS_PROXY, 'http://custom.test');
  assert.equal(env.NODE_USE_ENV_PROXY, '0');
  assert.equal(env.NO_PROXY, 'localhost');
  for (const probe of [{ status: 1 }, { status: 0, stdout: 'invalid' }, { status: 0, stdout: '["",""]' }]) {
    assert.equal(importNetworkEnv({}, 'win32', () => probe).HTTPS_PROXY, undefined);
  }
  assert.equal(importNetworkEnv({}, 'linux', () => assert.fail('Windows only')).HTTPS_PROXY, undefined);
});
