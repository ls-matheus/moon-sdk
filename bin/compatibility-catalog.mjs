import { readFileSync } from 'node:fs';
export const reference = JSON.parse(readFileSync(new URL('./base44-reference.json', import.meta.url), 'utf8'));
const modules = { Base44Client: '', EntityHandler: 'entities.*', AuthModule: 'auth', InternalAuthModule: 'auth', FunctionsModule: 'functions', AgentsModule: 'agents', CoreIntegrations: 'integrations.Core', CustomIntegrationsModule: 'integrations.custom', ConnectorsModule: 'asServiceRole.connectors', UserConnectorsModule: 'connectors', AiGatewayModule: 'aiGateway', AppModule: 'app', AppLogsModule: 'appLogs', AnalyticsModule: 'analytics', ActorsModule: 'actors', ActorRef: 'actors.*', ActorClient: 'actors.*', Connection: 'actors.*.connection', SsoModule: 'asServiceRole.sso' };
const local = new Set(['cleanup', 'fetchWithAuth', ...['list', 'filter', 'get', 'create', 'update', 'delete', 'bulkCreate', 'bulkUpdate'].map(name => 'entities.*.' + name), 'functions.invoke', 'functions.fetch', 'app.getPublicSettings']);
const conditional = new Set(['integrations.Core.InvokeLLM', ...['me', 'updateMe', 'redirectToLogin', 'loginWithProvider', 'logout', 'loginViaEmailPassword', 'isAuthenticated', 'register', 'verifyOtp', 'resendOtp', 'resetPasswordRequest'].map(name => 'auth.' + name), 'analytics.track', 'appLogs.logUserInApp']);
export const catalog = Object.fromEntries(Object.entries(modules).flatMap(([type, prefix]) => reference.interfaces[type].members.filter(member => member.kind === 'method').map(member => {
  const feature = [prefix, member.name].filter(Boolean).join('.');
  return [feature, { status: local.has(feature) ? 'local' : conditional.has(feature) ? 'conditional' : 'adapter_required', signature: member.signature, reference: reference.interfaces[type].file }];
})));

export function featureStatus(path, backend = false) {
  let normalized = path.replace(/^asServiceRole\.(?=entities\.|integrations\.)/, '').replace(/^entities\.[^.]+\./, 'entities.*.');
  if (backend && !normalized.startsWith('entities.') && normalized !== 'integrations.Core.InvokeLLM' && normalized !== 'auth.me') return { feature: normalized, status: 'adapter_required' };
  const entry = catalog[normalized];
  return { feature: normalized, status: entry?.status || 'adapter_required' };
}
