// Recompute public runtime selectors for every snapshot; old VITE values may be stale.
export function withRuntimeAliases(provider, values) {
  const authProvider = values.MOON_AUTH_PROVIDER || (provider === 'firebase' ? 'firebase' : 'supabase');
  return {
    ...values,
    VITE_MOON_PROVIDER: provider,
    VITE_MOON_DEV_AUTH_BYPASS: provider === 'none' ? 'true' : 'false',
    VITE_MOON_AUTH_PROVIDER: authProvider,
    ...Object.fromEntries(['API_KEY', 'PROJECT_ID', 'AUTH_DOMAIN', 'APP_ID']
      .filter(key => values['MOON_FIREBASE_' + key])
      .map(key => ['VITE_MOON_FIREBASE_' + key, values['MOON_FIREBASE_' + key]])),
    ...(authProvider === 'supabase' ? {
      VITE_SUPABASE_URL: values.MOON_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: values.MOON_SUPABASE_ANON_KEY,
    } : {}),
  };
}
