// Public login roster — the minimal user list the picker needs on a brand-new
// device that has no local data and no token yet. Backed by GET /auth/roster,
// which exposes ONLY id/name/role/pin fields (no permissions, no business data).

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

export interface RosterUser {
  id: string;
  name: string;
  role: string;
  pin_length_required: number;
  pin_set: number; // 0 = must set a PIN on first sign-in, 1 = already set
  is_test?: number; // 1 = public demo account (sandboxed session)
  test_code?: string | null; // demo access code, shown under the login fields
}

/** Fetches the sign-in roster. Used only when the local DB is empty (new device). */
export async function fetchRoster(): Promise<RosterUser[]> {
  const res = await fetch(`${API_BASE}/auth/roster`);
  if (!res.ok) throw new Error(`Could not load the sign-in list (${res.status}).`);
  const data = (await res.json()) as { users: RosterUser[] };
  return data.users ?? [];
}
