// #235: engine.ts's pushEntries appends ' [ref <request-id>]' to an outbox
// entry's last_error, sourced from the server's X-Request-Id response header
// (apps/api/src/index.ts's onRequest hook) — a correlation id a support
// ticket can trace back to the exact request and its audit_log row. Pure
// parser so SyncIndicator can split it back out into its own subtle line
// instead of leaving a UUID buried inside the (possibly truncated/italicized)
// error text.
const REQUEST_REF = / \[ref ([^\]]+)\]$/;

export interface SplitRequestRef {
  text: string;
  ref: string | null;
}

export function splitRequestRef(message: string): SplitRequestRef {
  const m = REQUEST_REF.exec(message);
  if (!m) return { text: message, ref: null };
  return { text: message.slice(0, m.index), ref: m[1] };
}
