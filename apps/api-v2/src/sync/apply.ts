import { applyWritePolicy, isAllowedActivity, activityActionPolicy } from '../lib/syncPolicy';
import { resolvePrimaryClaim, isPrimaryConflict } from '../lib/mediaPrimary';
import { resolveActivityRefs, buildActivityMetadata } from '../lib/activityLog';
import { getNotifyConfig, deliver, resolveRecipients, claimEvent, releaseEvent, dedupKeys } from '../lib/notifications';
import { shouldNotifyDecision, approvalUpdateAllowed } from '../lib/approvals';
import { keyColumns, conflictTarget, INSERT_NO_UPSERT_TABLES } from './tables';
import type { OutboxEntry, Pg } from './types';

// Thrown by applyEntry when applyWritePolicy rejects columns a client may not
// write (SENSITIVE_DENY or non-real columns). A dedicated type so the push
// handler's catch can distinguish a schema-probing write from an ordinary
// rejection and flag it for the audit trail (outcome 'injection_attempt'),
// without brittle message-string matching.
export class ForbiddenColumnsError extends Error {}

// H3: normalise a client-supplied activity_log created_at. Past timestamps are
// preserved (offline events carry their real, earlier time — the whole point of
// client-supplied created_at). A timestamp beyond a small future skew tolerance,
// or one that doesn't parse, is stamped NOW: forging a plausible time is how a
// fabricated audit entry hides in the trail, and a real device never logs the
// future. Returns an ISO string (bound as the created_at param).
function clampActivityCreatedAt(raw: unknown): string {
  const now = Date.now();
  const SKEW_MS = 5 * 60_000;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const t = new Date(raw).getTime();
    if (!Number.isNaN(t) && t <= now + SKEW_MS) return new Date(t).toISOString();
  }
  return new Date(now).toISOString();
}

// Entity tables whose taxonomy reference is being migrated from a label column to
// a durable FK id (#74, migration 035). label = the human string column, id = the
// soft-FK column resolved from it, category = the taxonomy_types.category to match.
// A table may carry more than one such pair (inventory_items: item category +
// equipment type, #28/migration 048).
const TAXONOMY_FK_COLUMNS: Record<string, Array<{ label: string; id: string; category: string }>> = {
  teams: [{ label: 'type', id: 'type_id', category: 'team' }],
  jobs: [{ label: 'type', id: 'type_id', category: 'job' }],
  inventory_items: [
    { label: 'category', id: 'category_id', category: 'item_category' },
    { label: 'type', id: 'type_id', category: 'equipment' }, // #28
  ],
  locations: [{ label: 'type', id: 'type_id', category: 'location_type' }],
  repairs: [{ label: 'status', id: 'status_id', category: 'repair_status' }], // #74 Phase 3b
  vehicles: [{ label: 'model', id: 'model_id', category: 'vehicle_model' }], // #81/#125
};

export async function applyEntry(
  pg: Pg,
  entry: OutboxEntry,
  callerUserId: string,
  realColumns: Map<string, Set<string>>,
  can: (perm: string) => boolean,
  // Items touched by ADJUSTs this batch — the caller runs one low-stock check per
  // item AFTER the whole batch commits (avoids the transfer race + re-arm gap).
  touchedItems?: Set<string>,
): Promise<void> {
  const { operation, table_name, payload } = entry;

  // activity_log is append-only (enforced by Postgres RULES). ON CONFLICT is
  // incompatible with rules, so insert idempotently via WHERE NOT EXISTS.
  if (table_name === 'activity_log') {
    if (operation !== 'INSERT') return;
    if (!isAllowedActivity(payload.action, payload.entity_type)) {
      throw new Error('Invalid activity_log action/entity_type');
    }
    // H3: the caller's PERMISSION to push a privileged/forgeable action is gated
    // in the preAuthorize guard (guards/activityLog.ts) — done there, not here,
    // so a forged action is a permanent FORBIDDEN/NOT_ALLOWED conflict rather
    // than the generic retryable error this function's catch would produce.
    // Here we only normalise how the row is stored.
    const actionPolicy = activityActionPolicy(payload.action as string);
    // H3: clamp created_at — a legit offline event carries its real (earlier)
    // time, but a future or unparseable timestamp is how a forged row blends in.
    const createdAt = clampActivityCreatedAt(payload.created_at);
    // H3: privileged actions carry no device geo — an admin console change isn't
    // a field event and client-supplied coordinates on one are never trustworthy.
    const isPrivileged = actionPolicy.requiredPerm != null;
    const geoLat = isPrivileged ? null : (payload.latitude ?? null);
    const geoLong = isPrivileged ? null : (payload.longitude ?? null);
    const geoAcc = isPrivileged ? null : (payload.location_accuracy ?? null);
    // Attribute to the AUTHENTICATED caller, not the client-supplied user_id —
    // otherwise any token could forge audit entries blaming another user.
    // (created_at stays client-supplied: offline events carry their real time.)
    //
    // Deliberately NOT stamped with metadata.request_id: these rows were created
    // on-device, possibly days earlier while offline, and merely happen to be
    // carried by THIS push. Only server-written activity correlates to the
    // request that produced it.
    // A reference the server doesn't have must never cost us the audit row (#56):
    // null the unresolvable column, keep the id under metadata.orphaned_refs,
    // record the row.
    const { values: refs, orphaned } = await resolveActivityRefs(pg, payload);
    await pg.query(
      `INSERT INTO activity_log
         (id, user_id, team_id, action, entity_type, entity_id,
          from_location_id, to_location_id, quantity, unit,
          job_id, note, metadata, device_id, created_at, synced_at,
          latitude, longitude, location_accuracy)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),$16,$17,$18
       WHERE NOT EXISTS (SELECT 1 FROM activity_log WHERE id = $1)`,
      [
        payload.id, callerUserId, refs.team_id,
        payload.action, payload.entity_type, refs.entity_id,
        refs.from_location_id, refs.to_location_id,
        payload.quantity ?? null, payload.unit ?? null,
        refs.job_id, payload.note ?? null,
        buildActivityMetadata(payload.metadata, orphaned),
        payload.device_id ?? null, createdAt,
        geoLat, geoLong, geoAcc,
      ]
    );
    return;
  }

  // Delta-based stock merge. Movement writers push a SIGNED delta; the server is
  // authoritative. Idempotent via processed_outbox (keyed on the outbox entry id):
  // a retried push finds the dedup row already present → dedup CTE is empty → the
  // INSERT/UPDATE produces no row, so the delta is applied exactly once. Clamped
  // with GREATEST(0, …) so it can never violate the quantity >= 0 CHECK. NOW() is
  // authoritative (never moves updated_at backwards, so other devices' incremental
  // pull `WHERE updated_at > since` always sees the change).
  if (operation === 'ADJUST' && table_name === 'stock_by_location') {
    const itemId = payload.item_id;
    const locationId = payload.location_id;
    const delta = payload.delta;
    if (itemId == null || locationId == null || delta == null) {
      throw new Error('ADJUST stock_by_location requires item_id, location_id, delta');
    }
    await pg.query(
      `WITH dedup AS (
         INSERT INTO processed_outbox (entry_id) VALUES ($1)
         ON CONFLICT (entry_id) DO NOTHING RETURNING entry_id)
       INSERT INTO stock_by_location (item_id, location_id, quantity, updated_at)
       SELECT $2, $3, GREATEST(0, $4), NOW() FROM dedup
       ON CONFLICT (item_id, location_id) DO UPDATE
         SET quantity = GREATEST(0, stock_by_location.quantity + $4),
             updated_at = NOW()`,
      [entry.id, itemId, locationId, delta]
    );
    // Record the touched item; the low-stock check runs once per item after the
    // whole batch commits (see sync/batch.ts) so paired transfer legs have all
    // landed and re-arm works regardless of delta sign.
    if (itemId != null) touchedItems?.add(String(itemId));
    return;
  }

  // ADJUST is only defined for stock_by_location; reject it for any other table
  // rather than letting it fall through to the generic full-row upsert.
  if (operation === 'ADJUST') {
    throw new Error(`ADJUST not supported for table ${table_name}`);
  }

  const keys = keyColumns(table_name);

  if (operation === 'DELETE') {
    const where = keys.map((k, i) => `${k} = $${i + 1}`).join(' AND ');
    await pg.query(`DELETE FROM ${table_name} WHERE ${where}`, keys.map(k => payload[k]));
    return;
  }

  // Taxonomy label→FK cutover (#74): for entity tables carrying a soft taxonomy
  // reference, resolve the *_id from the label SERVER-SIDE so it is authoritative
  // and gets set even when an older/other client didn't send it. Only fills when a
  // label is present and the id is absent from the payload (never clobber an id the
  // client already resolved). Deterministic when duplicate labels exist (matches
  // migration 035's backfill: active first, then sort_order, then id). This runs
  // for INSERT and UPDATE — ADJUST/DELETE already returned above.
  for (const taxoFk of TAXONOMY_FK_COLUMNS[table_name] ?? []) {
    if (payload[taxoFk.label] == null || payload[taxoFk.id] != null) continue;
    const { rows: fkRows } = await pg.query(
      `SELECT id FROM taxonomy_types WHERE category = $1 AND label = $2
       ORDER BY active DESC, sort_order ASC, id ASC LIMIT 1`,
      [taxoFk.category, payload[taxoFk.label]]
    );
    if (fkRows[0]) payload[taxoFk.id] = (fkRows[0] as { id: string }).id;
  }

  // `synced_at` is a device-local-only column (it does not exist on any server
  // table). Some client flows leak it into the payload; strip it here so the
  // generated SQL never references a nonexistent column (which would throw and
  // strand the entry as a conflict forever).
  if (operation === 'UPDATE') {
    // Filter to real columns, strip server-controlled cols, drop attribution
    // reassignment, and reject the whole entry if it touched a sensitive column.
    const { row, rejected } = applyWritePolicy(table_name, 'UPDATE', payload, callerUserId, realColumns, can);
    if (rejected.length) throw new ForbiddenColumnsError(`Forbidden columns: ${rejected.join(', ')}`);
    // media: a client may not mint a SECOND primary for an entity (bug #50) —
    // a losing claim is coerced to false. Closes the path rather than trusting
    // current client flows to stay primary-clearing.
    if (table_name === 'media') await resolvePrimaryClaim(pg, row, payload.id);
    const hasUpdatedAt = realColumns.get(table_name)?.has('updated_at') ?? false;
    // Real partial update — only the columns the device actually changed.
    // updated_at is server-authoritative (never trust the client clock) — strip
    // any client-supplied value and force NOW() below instead.
    const cols = Object.keys(row).filter(k => k !== '__version' && k !== 'synced_at' && k !== 'updated_at' && !keys.includes(k));
    if (cols.length === 0 && !hasUpdatedAt) return;
    // Clamp absolute stock writes so a bad value can't throw the quantity >= 0
    // CHECK and strand the entry forever.
    const setParts = cols.map((c, i) => {
      const ph = `$${i + 1}`;
      return table_name === 'stock_by_location' && c === 'quantity'
        ? `${c} = GREATEST(0, ${ph})`
        : `${c} = ${ph}`;
    });
    if (hasUpdatedAt) setParts.push('updated_at = NOW()');
    const setClause = setParts.join(', ');
    // Capture the pre-update assignee so we notify only on an ACTUAL assignment
    // change (not retries of a settled row, and not unrelated edits that happen
    // to carry assignee_id) and only when the repair actually exists. A failed
    // pre-read → skip the notify, never block the write.
    let prevAssignee: string | null | undefined; // undefined = repair not found / unknown
    if (table_name === 'repairs' && payload.assignee_id) {
      try {
        const { rows: pre } = await pg.query(`SELECT assignee_id FROM repairs WHERE id = $1`, [payload.id]);
        prevAssignee = pre[0] ? ((pre[0] as { assignee_id: string | null }).assignee_id ?? null) : undefined;
      } catch { prevAssignee = undefined; }
    }
    // Approval-decision guard + notify. Capture the pre-row status/requester so we
    // (a) only let an approver — or the requester CANCELLING their own row — change
    // the status, and (b) notify the requester only on a real open->decided move.
    // Attribution (requester_id) was already stripped by applyWritePolicy above, so
    // the guard trusts the DB's requester_id, never the payload's. A failed pre-read
    // → apprPre undefined → no guard/notify (the write still applies).
    let apprPre: { status: string; requester_id: string } | undefined;
    if (table_name === 'approval_requests') {
      try {
        const { rows: pre } = await pg.query(`SELECT status, requester_id FROM approval_requests WHERE id = $1`, [payload.id]);
        apprPre = pre[0] as { status: string; requester_id: string } | undefined;
      } catch { apprPre = undefined; }
      if (apprPre) {
        const touchesDecision = ['status', 'decided_by', 'decided_at', 'decision_note'].some(k => k in payload);
        const nextStatus = payload.status != null ? String(payload.status) : apprPre.status;
        const changesStatus = nextStatus !== apprPre.status;
        // Any write to a decision field requires authorization — not only a status
        // change. Otherwise a non-approver could stamp decided_by/decided_at on an
        // open row (status unchanged) and pollute the audit trail.
        if (touchesDecision) {
          const approvers = await resolveRecipients(pg, 'approvals', { userId: apprPre.requester_id });
          const callerIsApprover = approvers.includes(callerUserId) || can('manage_teams');
          const callerIsRequester = String(apprPre.requester_id) === callerUserId;
          const guard = approvalUpdateAllowed({ changesStatus, nextStatus, callerIsApprover, callerIsRequester });
          if (!guard.allowed) throw new Error(guard.reason ?? 'Forbidden: approval decision not permitted');
        }
      }
    }
    let where = keys.map((k, i) => `${k} = $${cols.length + i + 1}`).join(' AND ');
    const whereParams: unknown[] = keys.map(k => payload[k]);
    // notifications: enforce row ownership in SQL, not just via the payload check —
    // a mark-read UPDATE keyed on id alone (SENSITIVE_DENY strips user_id from the
    // payload) would otherwise be able to flip ANY row's read_at by guessing its id.
    if (table_name === 'notifications') {
      where += ` AND user_id = $${cols.length + keys.length + 1}`;
      whereParams.push(callerUserId);
    }
    await pg.query(
      `UPDATE ${table_name} SET ${setClause} WHERE ${where}`,
      [...cols.map(c => row[c] ?? null), ...whereParams]
    );
    // Assignment notification (fire-and-forget; never blocks the sync write).
    // jobs has no assignee column (checked migrations) — repairs-only is correct.
    // Change-detection (new !== prev) makes this idempotent on retry and re-fires
    // on a genuine re-assignment, without a persistent dedup key.
    if (table_name === 'repairs' && payload.assignee_id && prevAssignee !== undefined
        && String(payload.assignee_id) !== String(prevAssignee ?? '')) {
      const assignee = String(payload.assignee_id);
      const repairId = String(payload.id);
      void (async () => {
        try {
          if (!(await getNotifyConfig(pg)).enabled) return;
          // Dedup identical (repair, assignee) assignments so a retried push (or a
          // reassign-back to the same person still open) can't re-notify. resolveRecipients
          // additionally gates the assignee to someone the actor shares a team with, so a
          // crafted repair UPDATE can't spam an arbitrary user id.
          if (!(await claimEvent(pg, dedupKeys.assign(repairId, assignee)))) return;
          const recipients = await resolveRecipients(pg, 'assignment', { userId: assignee, actorId: callerUserId });
          if (!recipients.length) { await releaseEvent(pg, dedupKeys.assign(repairId, assignee)); return; }
          await deliver(pg, recipients, { type: 'assignment', title: 'New assignment', body: 'You have been assigned a repair.', data: { screen: 'repairs', id: repairId } });
        } catch { /* never disrupt sync */ }
      })();
    }
    // Approval-decision notification (fire-and-forget). Only a genuine open->approved/
    // rejected transition notifies the requester; deduped on (id,status) so a retried
    // push doesn't re-notify, and a later re-decision (different status) still fires.
    if (table_name === 'approval_requests' && apprPre
        && shouldNotifyDecision(apprPre.status, payload.status != null ? String(payload.status) : undefined)) {
      const requester = String(apprPre.requester_id);
      const reqId = String(payload.id);
      const newStatus = String(payload.status);
      void (async () => {
        try {
          if (!(await getNotifyConfig(pg)).enabled) return;
          if (await claimEvent(pg, dedupKeys.apprDecision(reqId, newStatus))) {
            const body = String(payload.decision_note ?? payload.title ?? '');
            await deliver(pg, [requester], { type: 'approval_decision', title: `Request ${newStatus}`, body, data: { screen: 'notifications', id: reqId } });
          }
        } catch { /* never disrupt sync */ }
      })();
    }
    return;
  }

  // INSERT — full-row upsert (keyed by primary/composite key).
  // Apply the write policy first so attribution cols are forced to the caller,
  // sensitive cols reject the entry, and non-column keys are dropped; build the
  // row from the resulting policy-filtered `row`.
  const { row, rejected } = applyWritePolicy(table_name, 'INSERT', payload, callerUserId, realColumns, can);
  if (rejected.length) throw new ForbiddenColumnsError(`Forbidden columns: ${rejected.join(', ')}`);
  // approval_requests: a client INSERT may only CREATE an OPEN request. The
  // decision fields are reachable ONLY through the guarded UPDATE path — otherwise
  // an INSERT carrying an EXISTING id would upsert (ON CONFLICT DO UPDATE) straight
  // past the approver guard, letting a non-approver approve or a requester
  // self-approve with a forged decided_by. Force the row open + strip any
  // client-supplied decision; the DO-NOTHING conflict below makes a re-sent create
  // idempotent instead of an update. (decided_by/decided_at are also in
  // SENSITIVE_DENY, so a present value would already have been rejected above.)
  if (table_name === 'approval_requests') {
    row.status = 'open';
    delete row.decided_by; delete row.decided_at; delete row.decision_note;
  }
  // media: "first photo becomes primary" is elected on the CLIENT from its local
  // replica, so two devices uploading to the same empty entity both claim it and
  // both rows land (distinct UUIDs → they never collide on the conflict target).
  // The server arbitrates: first claim wins, a later one is coerced to false and
  // flows back on the next pull (updated_at = NOW() below). Bug #50.
  if (table_name === 'media') await resolvePrimaryClaim(pg, row, row.id);
  const target = conflictTarget(table_name);
  const targetCols = new Set(keys);
  const hasUpdatedAt = realColumns.get(table_name)?.has('updated_at') ?? false;
  // updated_at is server-authoritative on INSERT too (offline created_at stays
  // client-supplied — see the activity_log rationale above — but updated_at is
  // always the server's NOW()).
  const allKeys = Object.keys(row).filter(k => k !== '__version' && k !== 'synced_at' && k !== 'updated_at');
  const cols = (hasUpdatedAt ? [...allKeys, 'updated_at'] : allKeys).join(', ');
  // Clamp absolute stock writes (both the VALUES and the DO UPDATE) with
  // GREATEST(0, …) so a bad absolute can't violate the quantity >= 0 CHECK.
  const clampStock = (k: string, ph: string) =>
    table_name === 'stock_by_location' && k === 'quantity' ? `GREATEST(0, ${ph})` : ph;
  const valParts = allKeys.map((k, i) => clampStock(k, `$${i + 1}`));
  if (hasUpdatedAt) valParts.push('NOW()');
  const vals = valParts.join(', ');
  const updateParts = allKeys
    .filter(k => !targetCols.has(k))
    .map(k => `${k} = ${clampStock(k, `$${allKeys.indexOf(k) + 1}`)}`);
  if (hasUpdatedAt) updateParts.push('updated_at = NOW()');
  const updates = updateParts.join(', ');

  // INSERT_NO_UPSERT tables never upsert: a create is a create, and an INSERT
  // carrying an existing key is a no-op, not a back-door update (rationale per
  // table in the manifest; approval_requests also has the force-open block above).
  const sql = updates && !INSERT_NO_UPSERT_TABLES.has(table_name)
    ? `INSERT INTO ${table_name} (${cols}) VALUES (${vals})
       ON CONFLICT (${target}) DO UPDATE SET ${updates}`
    : `INSERT INTO ${table_name} (${cols}) VALUES (${vals})
       ON CONFLICT (${target}) DO NOTHING`;

  try {
    await pg.query(sql, allKeys.map(k => row[k] ?? null));
  } catch (err) {
    // Another device won the primary between our existence check above and this
    // write (migration 050's partial unique index caught it). Retry as non-primary
    // instead of stranding the entry as a permanent conflict — an unsynced photo is
    // worse than an unstarred one.
    if (!isPrimaryConflict(err)) throw err;
    row.is_primary = false;
    await pg.query(sql, allKeys.map(k => row[k] ?? null));
  }

  // New approval request → notify the approvers once (deduped on request id so a
  // retried push doesn't re-notify). Fire-and-forget; never blocks the sync write.
  // requester_id was forced to the caller by applyWritePolicy (ATTRIBUTION_COLUMNS).
  if (table_name === 'approval_requests' && row.id) {
    const reqId = String(row.id);
    const requester = row.requester_id != null ? String(row.requester_id) : callerUserId;
    const reqTitle = row.title != null ? String(row.title) : 'Approval requested';
    void (async () => {
      try {
        if (!(await getNotifyConfig(pg)).enabled) return;
        if (await claimEvent(pg, dedupKeys.approval(reqId))) {
          const to = await resolveRecipients(pg, 'approvals', { userId: requester });
          await deliver(pg, to, { type: 'approval_request', title: 'Approval requested', body: reqTitle, data: { screen: 'notifications', id: reqId }, createdBy: requester });
        }
      } catch { /* never disrupt sync */ }
    })();
  }

  // New coverage row → notify the other PMs + notify_route_on_call once
  // (deduped on the coverage id so a retried push doesn't re-notify).
  if (table_name === 'on_call_coverage' && row.id) {
    const covId = String(row.id);
    const dateStart = String(row.date_start ?? '');
    const dateEnd = String(row.date_end ?? '');
    const offId = row.user_off != null ? String(row.user_off) : null;
    const coverId = row.covering_user != null ? String(row.covering_user) : null;
    void (async () => {
      try {
        if (!(await getNotifyConfig(pg)).enabled) return;
        if (await claimEvent(pg, dedupKeys.coverage(covId))) {
          const { rows: nameRows } = await pg.query(
            `SELECT id, name FROM users WHERE id = ANY($1)`,
            [[offId, coverId].filter(Boolean)]);
          const nameOf = (id: string | null) =>
            (nameRows as { id: string; name: string }[]).find(r => String(r.id) === id)?.name ?? 'Someone';
          const to = await resolveRecipients(pg, 'on_call', { actorId: callerUserId });
          await deliver(pg, to, {
            type: 'on_call',
            title: 'On-call coverage',
            body: `${nameOf(coverId)} is covering for ${nameOf(offId)} (${dateStart} – ${dateEnd}).`,
            data: { screen: 'dashboard' },
            createdBy: callerUserId,
          });
        }
      } catch { /* never disrupt sync */ }
    })();
  }
}
