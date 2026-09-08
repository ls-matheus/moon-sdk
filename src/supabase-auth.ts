import type { AuthAdapter, User } from './types.js';

function publicUser(value: any): User | null {
  if (!value) return null;
  return { ...value.user_metadata, ...value, role: value.app_metadata?.role || 'user' };
}

export function createSupabaseAuthAdapter(auth: any): AuthAdapter {
  const unwrap = async (result: PromiseLike<any>) => {
    const { data, error } = await result;
    if (error && error.name !== 'AuthSessionMissingError') throw error;
    return data;
  };
  const normalize = (data: any) => ({ ...data, user: publicUser(data?.user), session: data?.session ? { ...data.session, user: publicUser(data.session.user) } : null });
  return {
    getSession: async () => normalize(await unwrap(auth.getSession())),
    getUser: async () => normalize(await unwrap(auth.getUser())),
    signInWithPassword: async credentials => normalize(await unwrap(auth.signInWithPassword(credentials))),
    signUp: async credentials => normalize(await unwrap(auth.signUp(credentials))),
    signOut: async () => { await unwrap(auth.signOut()); },
    updateUser: async attributes => {
      const { email, password, nonce, data, ...profile } = attributes;
      const result = await unwrap(auth.updateUser({
        ...(email !== undefined ? { email } : {}), ...(password !== undefined ? { password } : {}), ...(nonce !== undefined ? { nonce } : {}),
        data: { ...(data && typeof data === 'object' ? data : {}), ...profile },
      }));
      return { user: publicUser(result?.user) };
    },
    resetPasswordForEmail: async (email, settings) => { await unwrap(auth.resetPasswordForEmail(email, settings)); },
    signInWithOAuth: async settings => { await unwrap(auth.signInWithOAuth(settings)); },
    verifyOtp: async params => { await unwrap(auth.verifyOtp(params)); },
    resend: async params => { await unwrap(auth.resend(params)); },
    onAuthStateChange: callback => auth.onAuthStateChange((event: string, session: any) => callback({ event, session: session ? { ...session, user: publicUser(session.user)! } : null })).data.subscription,
  };
}
