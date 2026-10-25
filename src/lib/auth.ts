const AUTH_BASE = 'https://auth.novashang.com';

export type Session = {
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    emailVerified?: boolean;
  };
  session: {
    id: string;
    expiresAt: number;
  };
};

export async function fetchSession(): Promise<Session | null> {
  try {
    const r = await fetch(`${AUTH_BASE}/api/me`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) return null;
    return (await r.json()) as Session;
  } catch {
    return null;
  }
}

export async function signOut(): Promise<void> {
  try {
    await fetch(`${AUTH_BASE}/api/auth/sign-out`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // best-effort
  }
}

export function loginUrl(redirectTo: string): string {
  const u = new URL('/auth/login', AUTH_BASE);
  u.searchParams.set('redirect_to', redirectTo);
  return u.toString();
}
