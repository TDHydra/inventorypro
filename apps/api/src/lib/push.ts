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

// Classifies dead tokens from Expo's receipts (the second stage of Expo's
// ticket→receipt flow). Used by sendPush's receipts poll below, which catches
// the uninstalled-device case that the immediate ticket doesn't report.
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
    // receiptId -> token, for the second-stage receipts poll below. Expo
    // reports an uninstalled-but-valid token as DeviceNotRegistered on the
    // RECEIPT, not the initial ticket (which comes back "ok"), so the inline
    // ticket check alone misses the common uninstall case.
    const receiptTokens: Record<string, string> = {};
    for (const batch of chunk(tokens, 100)) {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(buildMessages(batch, payload)),
      });
      const json = await res.json().catch(() => null) as any;
      const tickets = json?.data ?? [];
      const deadNow: string[] = [];
      tickets.forEach((t: any, i: number) => {
        if (t?.status === 'error' && (t?.details?.error === 'DeviceNotRegistered' || t?.details?.error === 'InvalidCredentials')) {
          deadNow.push(batch[i]);
        } else if (t?.status === 'ok') {
          sent++;
          if (typeof t.id === 'string') receiptTokens[t.id] = batch[i];
        }
      });
      await disableTokens(pg, deadNow);
    }
    // Second stage: poll receipts for the accepted tickets and disable any
    // token Expo now reports dead (DeviceNotRegistered / InvalidCredentials).
    const receiptIds = Object.keys(receiptTokens);
    if (receiptIds.length) {
      try {
        const rres = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ ids: receiptIds }),
        });
        const rjson = await rres.json().catch(() => null) as any;
        if (rjson?.data) await disableTokens(pg, deadTokensFromReceipts(rjson.data, receiptTokens));
      } catch { /* receipts are best-effort; never fail the send */ }
    }
    return { sent };
  } catch {
    return { sent: 0 }; // push failures never propagate
  }
}
