import { createFunctionInvoker, createFunctionFetch, createFetchWithAuth, createLoginRedirect, createLLMInvoker } from './client-bridge.mjs';

export class Base44Error extends Error {
  constructor(message, status, code, data, originalError) {
    super(message); this.name = 'Base44Error'; this.status = status; this.code = code;
    this.data = data; this.originalError = originalError; this.response = { status, data };
  }
  toJSON() { return { name: this.name, message: this.message, status: this.status, code: this.code, data: this.data }; }
}

export class MoonCompatibilityError extends Base44Error {
  constructor(feature) {
    super(`Recurso ${feature} precisa de um adaptador local. Execute moon inspect para revisar a compatibilidade.`);
    this.name = 'MoonCompatibilityError'; this.code = 'MOON_UNSUPPORTED'; this.feature = feature;
    this.status = 501; this.data = { error: this.message, code: this.code, feature };
    this.response = { status: this.status, data: this.data };
  }
}

function unavailable(path) {
  return new Proxy(function () { throw new MoonCompatibilityError(path); }, {
    get(_target, key) { return typeof key === 'symbol' || key === 'then' ? undefined : unavailable(path + '.' + key); },
  });
}

function moduleWithAdapters(path, implementation = {}, adapter = {}) {
  return new Proxy(implementation, {
    get(target, key) {
      if (typeof key !== 'string' || key === 'then') return undefined;
      const owner = Object.hasOwn(adapter, key) ? adapter : Object.hasOwn(target, key) ? target : null;
      if (owner) {
        const value = owner[key];
        if (typeof value !== 'function') return value;
        const convert = error => { throw error instanceof Base44Error ? error : new Base44Error(error.message || String(error), error.status || error.response?.status || 500, error.code || 'MOON_ERROR', error.data || error.response?.data, error); };
        return (...args) => {
          try { const result = value.apply(owner, args); return result?.then ? result.catch(convert) : result; }
          catch (error) { return convert(error); }
        };
      }
      return unavailable(path + '.' + key);
    },
  });
}

// Adapters are app-owned implementations. Unimplemented services never return fake success.
export function createPortableClient(sdk, { appId = 'moon-local', provider = 'none', loginUi = { mode: 'app', loginPath: null }, request = globalThis.fetch, location = globalThis.location, adapters = {}, analytics = { enabled: false }, activityStorage = globalThis.localStorage } = {}) {
  let activity = [];
  const activityKey = 'moon:activity:' + appId;
  const redirect = createLoginRedirect(loginUi, location);
  const auth = moduleWithAdapters('auth', {
    me: async () => {
      const user = await sdk.auth.me();
      if (!user) throw Object.assign(new Error('Login necessário.'), { status: 401, data: { error: 'Login necessário.' }, response: { status: 401, data: { error: 'Login necessário.' } } });
      return user;
    }, isAuthenticated: () => sdk.auth.isAuthenticated(),
    loginViaEmailPassword: (email, password) => sdk.auth.loginViaEmailPassword(email, password),
    register: params => sdk.auth.register({ ...params, options: { ...params.options, ...(location?.origin ? { emailRedirectTo: location.origin } : {}) } }),
    updateMe: data => sdk.auth.updateMe(data),
    logout: async redirectUrl => { await sdk.auth.logout(); if (redirectUrl) location?.assign(redirectUrl); },
    redirectToLogin: redirect,
    loginWithProvider: (provider, redirectTo = location?.href) => sdk.auth.loginWithProvider(provider, redirectTo),
    resetPasswordRequest: email => sdk.auth.resetPasswordForEmail(email, { redirectTo: location?.origin }),
    verifyOtp: ({ otpCode, ...params }) => sdk.auth.verifyOtp({ ...params, token: otpCode || params.token }),
    resendOtp: email => sdk.auth.resendOtp({ email, type: 'signup' }),
    onAuthStateChange: callback => sdk.auth.onChange(callback),
  }, adapters.auth);
  const integrations = new Proxy({}, { get(_target, packageName) {
    if (typeof packageName !== 'string' || packageName === 'then') return undefined;
    return moduleWithAdapters('integrations.' + packageName, packageName === 'Core' ? { InvokeLLM: createLLMInvoker(sdk.auth, request) } : {}, adapters.integrations?.[packageName]);
  } });
  const entities = new Proxy({}, { get(_target, name) {
    if (typeof name !== 'string' || name === 'then') return undefined;
    return moduleWithAdapters('entities.' + name, sdk.entities[name], adapters.entities?.[name]);
  } });
  return moduleWithAdapters('client', {
    auth, entities, integrations,
    app: moduleWithAdapters('app', { getPublicSettings: async () => ({ id: appId, public_settings: provider === 'none' || loginUi.mode === 'public' ? 'public_without_login' : 'public_with_login' }) }, adapters.app),
    functions: moduleWithAdapters('functions', { invoke: createFunctionInvoker(sdk.auth, request), fetch: createFunctionFetch(sdk.auth, request) }, adapters.functions),
    fetchWithAuth: createFetchWithAuth(sdk.auth, request),
    analytics: moduleWithAdapters('analytics', analytics.enabled === false ? { track: () => undefined } : {}, adapters.analytics),
    agents: moduleWithAdapters('agents', {}, adapters.agents),
    connectors: moduleWithAdapters('connectors', {}, adapters.connectors),
    aiGateway: moduleWithAdapters('aiGateway', {}, adapters.aiGateway),
    actors: moduleWithAdapters('actors', {}, adapters.actors),
    appLogs: moduleWithAdapters('appLogs', { logUserInApp: async pageName => {
      if (typeof pageName !== 'string' || !pageName || pageName.length > 1000) throw new Error('Nome de página inválido.');
      if (activityStorage) { try { const stored = JSON.parse(activityStorage.getItem(activityKey) || '[]'); activity = Array.isArray(stored) ? stored : []; } catch { activity = []; } }
      const next = [...activity.slice(-999), { page_name: pageName, created_date: new Date().toISOString() }];
      activityStorage?.setItem(activityKey, JSON.stringify(next));
      activity = next;
    } }, adapters.appLogs),
    cleanup: () => { sdk.cleanup(); adapters.cleanup?.(); },
  }, adapters.client);
}
