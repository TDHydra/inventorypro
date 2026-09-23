import { randomUUID } from 'node:crypto';
import { getNotifyConfig, notifyLowStock, deliver, resolveRecipients, claimEvent, dedupKeys } from '../lib/notifications';
import { isThresholdMovement, parseThreshold } from '../lib/approvals';
import type { OutboxEntry, Pg } from './types';

// Post-batch side effects — run ONCE after every entry of a push has been
// processed, all fire-and-forget (never delay or fail the sync response).
// Split from the route so the skeleton stays thin; behavior is verbatim from
// the old monolith's post-loop blocks.
export function runPostBatchNotifiers(
  pg: Pg,
  userId: string,
  entries: OutboxEntry[],
  ok: string[],
  touchedItems: Set<string>,
): void {
  // Low-stock notifications: one check per item touched by an ADJUST this batch,
  // AFTER every entry (incl. paired transfer legs) has committed. notifyLowStock
  // re-arms + is idempotent.
  if (touchedItems.size > 0) {
    void (async () => {
      try {
        if (!(await getNotifyConfig(pg)).enabled) return;
        for (const itemId of touchedItems) await notifyLowStock(pg, itemId);
      } catch { /* never disrupt sync */ }
    })();
  }

  // #230: schedule-change notifications — one per affected (employee, day)
  // pair among this batch's committed schedule_assignments writes, resolved
  // from the DB (an UPDATE payload may not carry employee_id/day). Deduped
  // per source outbox entry via claimEvent so a retried push (whose entries
  // short-circuit through processed_outbox into `ok`) can't re-notify.
  // Self-scheduling never notifies.
  const okIds = new Set(ok);
  const schedEntries = entries.filter(e => okIds.has(e.id)
    && e.table_name === 'schedule_assignments'
    && (e.operation === 'INSERT' || e.operation === 'UPDATE'));
  if (schedEntries.length > 0) {
    void (async () => {
      try {
        if (!(await getNotifyConfig(pg)).enabled) return;
        const rowIds: string[] = [];
        for (const e of schedEntries) {
          if (!(await claimEvent(pg, dedupKeys.sched(String(e.id))))) continue;
          if (e.payload.id != null) rowIds.push(String(e.payload.id));
        }
        if (!rowIds.length) return;
        const { rows } = await pg.query(
          `SELECT DISTINCT employee_id, day FROM schedule_assignments WHERE id = ANY($1)`,
          [rowIds]);
        for (const r of rows as { employee_id: string; day: string }[]) {
          if (String(r.employee_id) === userId) continue;
          const recipients = await resolveRecipients(pg, 'schedule', { userId: String(r.employee_id), actorId: userId });
          if (!recipients.length) continue;
          await deliver(pg, recipients, {
            type: 'schedule',
            title: 'Schedule updated',
            body: `Your schedule for ${r.day} changed.`,
            data: { screen: 'schedule', day: r.day },
            createdBy: userId,
          });
        }
      } catch { /* never disrupt sync */ }
    })();
  }

  // Threshold auto-flag: any large (|qty| >= approval_threshold_qty) stock movement
  // committed this batch auto-files a review approval_request + notifies approvers.
  // Non-blocking — the movement already applied; this is a post-hoc review flag.
  // Deduped per source outbox op id so a retried push can't file duplicates.
  if (entries.some(e => okIds.has(e.id) && e.table_name === 'stock_by_location' && e.operation === 'ADJUST')) {
    void (async () => {
      try {
        const { rows: tRows } = await pg.query(`SELECT value FROM app_config WHERE key = 'approval_threshold_qty'`, []);
        const threshold = parseThreshold(tRows[0] ? (tRows[0] as { value: string }).value : undefined);
        if (!(threshold > 0)) return;
        for (const entry of entries) {
          if (!okIds.has(entry.id) || !isThresholdMovement(entry, threshold)) continue;
          // Dedup on the source op id: a retried push must not re-file the request.
          if (!(await claimEvent(pg, `approval:auto:${entry.id}`))) continue;
          const qty = Number((entry.payload as { delta?: unknown }).delta);
          const itemId = (entry.payload as { item_id?: unknown }).item_id ?? null;
          const locationId = (entry.payload as { location_id?: unknown }).location_id ?? null;
          let itemName = 'an item';
          try {
            const { rows: iRows } = await pg.query(`SELECT name FROM inventory_items WHERE id = $1`, [itemId]);
            if (iRows[0]) itemName = String((iRows[0] as { name: string }).name);
          } catch { /* name is best-effort */ }
          const reqId = randomUUID();
          const title = `Large movement: ${itemName} (${qty >= 0 ? '+' : ''}${qty})`;
          const metadata = JSON.stringify({ opId: entry.id, itemId, locationId, qty });
          await pg.query(
            `INSERT INTO approval_requests (id, requester_id, kind, title, status, entity_type, entity_id, metadata)
             VALUES ($1,$2,'threshold_checkout',$3,'open','item',$4,$5)`,
            [reqId, userId, title, itemId, metadata]);
          // Notify approvers (deduped on the new request id, mirroring the INSERT hook).
          if (await claimEvent(pg, dedupKeys.approval(reqId))) {
            const to = await resolveRecipients(pg, 'approvals', { userId });
            await deliver(pg, to, { type: 'approval_request', title: 'Approval requested', body: title, data: { screen: 'notifications', id: reqId }, createdBy: userId });
          }
        }
      } catch { /* never disrupt sync */ }
    })();
  }
}
