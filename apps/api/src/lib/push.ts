// Expo Push delivery primitive. No firebase-admin, no service-account key on
// this server — Android push credentials live in EAS only. Fire-and-forget:
// sendPush() never throws into business logic (callers can call it inline
// without try/catch).
type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function buildMessages(tokens: string[], p: PushPayload): ExpoMessage[] {
  return tokens.map(to => ({ to, title: p.title, body: p.body, ...(p.data ? { data: p.data } : {}) }));
}

// Used for the receipts-polling path (Expo's two-step ticket→receipt flow).
// v1 (sendPush below) disables tokens on immediate ticket errors, which covers
// the common DeviceNotRegistered case without a follow-up receipts fetch. This
// helper is exported so a later receipts-poller can reuse the same dead-token
// classification.
export function deadTokensFromReceipts(
  receipts: Record<string, { status: string; details?: { error?: string } }>,
  ticketTokens: Record<string, string>,
): string[] {
  const dead: string[] = [];
  for (const [id, r] of Object.entries(receipts)) {
    if (r.status === 'error' && (r.details?.error === 'DeviceNotRegistered' || r.details?.error === 'InvalidCredentials')) {
      if (ticketTokens[id]) dead.push(ticketTokens[id]);
    }
  }
  return dead;
}

async function disableTokens(pg: Pg, tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  await pg.query(`UPDATE device_push_tokens SET disabled = TRUE WHERE expo_push_token = ANY($1)`, [tokens]);
}

// Fire-and-forget from callers' view; never throws into business logic.
export async function sendPush(pg: Pg, userIds: string[], payload: PushPayload): Promise<{ sent: number }> {
  try {
    if (!userIds.length) return { sent: 0 };
    const { rows } = await pg.query(
      `SELECT expo_push_token FROM device_push_tokens WHERE user_id = ANY($1) AND disabled = FALSE`, [userIds]);
    const tokens = rows.map(r => r.expo_push_token as string);
    if (!tokens.length) return { sent: 0 };
    let sent = 0;
    for (const batch of chunk(tokens, 100)) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(buildMessages(batch, payload)),
      });
      const json = await res.json().catch(() => null) as any;
      const tickets = json?.data ?? [];
      // Immediate ticket errors that are DeviceNotRegistered → disable now.
      const deadNow: string[] = [];
      tickets.forEach((t: any, i: number) => {
        if (t?.status === 'error' && t?.details?.error === 'DeviceNotRegistered') deadNow.push(batch[i]);
        if (t?.status === 'ok') sent++;
      });
      await disableTokens(pg, deadNow);
    }
    return { sent };
  } catch {
    return { sent: 0 }; // push failures never propagate
  }
}
