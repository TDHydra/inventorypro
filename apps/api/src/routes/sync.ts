import { FastifyPluginAsync } from 'fastify';
import { userHasPermission, canActOnTarget, canAssignRole } from '../lib/permissions';
import { isOrgAuthority, resolveTeamAuthority } from '../lib/teamAuthority';
import { participantWriteAllowed, ChatConversationFacts } from '../lib/chatPolicy';
import { canManageUnitAccess } from '../lib/unitAccessPolicy';
import {
  loadTableColumns,
  applyWritePolicy,
  requiredOperationPerm,
  isAllowedActivity,
  selectColumnsFor,
  requiresRolesPermForTarget,
  validateMediaWrite,
} from '../lib/syncPolicy';
import { cleanupMediaObjects } from '../lib/mediaCleanup';
import { resolvePrimaryClaim, isPrimaryConflict } from '../lib/mediaPrimary';
import { resolveActivityRefs, buildActivityMetadata } from '../lib/activityLog';
import { TEST_ACCOUNT_WRITE_ERROR } from '../lib/testAccounts';
import { randomUUID } from 'node:crypto';
import { getNotifyConfig, notifyLowStock, deliver, resolveRecipients, claimEvent, releaseEvent, dedupKeys } from '../lib/notifications';
import { isThresholdMovement, shouldNotifyDecision, approvalUpdateAllowed, parseThreshold } from '../lib/approvals';
import { overLimit } from '../lib/rateLimit';
import { sendPush, messageRecipients } from '../lib/push';

interface OutboxEntry {
  id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'ADJUST';
  table_name: string;
  payload: Record<string, unknown>;
  created_at: string;
}

// Thrown by applyEntry when applyWritePolicy rejects columns a client may not
// write (SENSITIVE_DENY or non-real columns). A dedicated type so the push
// handler's catch can distinguish a schema-probing write from an ordinary
// rejection and flag it for the audit trail (outcome 'injection_attempt'),
// without brittle message-string matching.
class ForbiddenColumnsError extends Error {}

interface PushBody {
  entries: OutboxEntry[];
}

const ALLOWED_TABLES = new Set([
  'users', 'locations', 'inventory_items', 'stock_by_location',
  'jobs', 'teams', 'team_members', 'media', 'activity_log', 'role_settings',
  'equipment_units', 'app_config', 'taxonomy_types', 'repairs', 'repair_parts',
  'notifications', 'approval_requests', 'maintenance_events', 'label_templates',
  'dashboard_presets',
  'conversations', 'conversation_participants', 'messages',
  'user_prefs',
  'subteams', 'vehicles', 'vehicle_service_records', 'vehicle_checkouts',
  'locker_access', 'on_call_shifts', 'unit_access', 'on_call_coverage',
  'job_assignments',
]);

// Rows that must never be DELETED through the generic sync path: users are
// deactivated (active=false) not deleted, and roles/config persist. Blocks a
// manage_users holder from destroying a full_admin row via a crafted DELETE.
const DELETE_FORBIDDEN_TABLES = new Set(['users', 'role_settings', 'app_config']);

// Tables whose writes confer privilege — a crew JWT must NOT be able to escalate
// roles, rewrite the permission matrix, flip maintenance mode, or restructure
// teams via a hand-crafted outbox entry. Each maps to the permission the caller
// must actually hold (resolved server-side from the DB, never trusted from the
// JWT role claim). Operational tables (stock, inventory, equipment, jobs, media,
// activity_log, locations, taxonomy) stay open — that's the normal sync surface.
const PRIVILEGED_TABLE_PERM: Record<string, string> = {
  users:         'manage_users',
  role_settings: 'manage_roles_permissions',
  app_config:    'system_settings',
  teams:         'manage_teams',
  team_members:  'manage_teams',
  // Crews are roster structure — same gate as teams, PLUS the per-row
  // resolveTeamAuthority guard below (a tier-2 lead may only shape crews of a
  // team they actually manage).
  subteams:      'manage_teams',
};

// Upsert conflict target per table. Most are keyed by `id`, but a few use a
// composite primary key — using `id` for those throws "column id does not exist"
// and silently drops the write (this broke checkout/checkin stock sync).
const CONFLICT_TARGETS: Record<string, string> = {
  stock_by_location: 'item_id, location_id',
  team_members: 'team_id, user_id',
  role_settings: 'role',
  app_config: 'key',
  user_prefs: 'user_id',
  taxonomy_types: 'id',
  dashboard_presets: 'id',
  conversations: 'id',
  conversation_participants: 'conversation_id, user_id',
  messages: 'id',
  vehicles: 'location_id',
  locker_access: 'location_id, user_id',
  unit_access: 'location_id, user_id',
  // Keyed on the WEEK, not the row id: one crew per week, and a reassignment
  // from any device upserts over the standing assignment instead of duplicating.
  on_call_shifts: 'week_start',
};

// Tables whose INSERT must NOT upsert: the generic INSERT is ON CONFLICT DO
// UPDATE, so an INSERT carrying an EXISTING key would rewrite the row straight
// past every INSERT-time guard. approval_requests: decisions must flow through
// the guarded UPDATE path (see applyEntry). conversations: attribution forces
// created_by = caller, so an INSERT with an existing id would hand the caller
// creator-ship of ANY conversation (defeating the participant guard keyed on
// it) and let them rewrite kind/title. messages: a participant could rewrite
// another sender's message (sender_id is likewise forced to the caller).
// conversation_participants: a re-add of an existing member must not reset
// their notify_pref / last_read_at. For all four, a resent create is an
// idempotent no-op (DO NOTHING), which is what a retry wants anyway.
const INSERT_NO_UPSERT = new Set([
  'approval_requests', 'conversations', 'conversation_participants', 'messages',
]);

// Tables whose pull is scoped to the authenticated caller (private per-user data).
// The listed column is matched against the caller's user id so a device only ever
// downloads its own rows (e.g. the per-user notifications inbox).
// user_prefs: presentation prefs aren't secret, but scoping keeps pulls to the
// caller's own row (a device has no use for anyone else's theme choice).
const SCOPED_TABLES: Record<string, string> = { notifications: 'user_id', user_prefs: 'user_id' };

// Chat tables have a scoped pull the single-column SCOPED_TABLES map can't express:
// a device may only pull conversations/participants/messages for conversations it
// participates in. Returns the extra WHERE fragment (parameterized on the caller id
// via `callerParam`, e.g. '$2') for a chat table, or null for any other table.
//   conversations              → id IN (my conversation ids)
//   conversation_participants  → conversation_id IN (my conversation ids)  (so a
//                                device sees every member of its own conversations)
//   messages                   → conversation_id IN (my conversation ids)
function chatScopeSql(table: string, callerParam: string): string | null {
  const mine = `SELECT conversation_id FROM conversation_participants WHERE user_id = ${callerParam}`;
  switch (table) {
    case 'conversations': return `id IN (${mine})`;
    case 'conversation_participants': return `conversation_id IN (${mine})`;
    case 'messages': return `conversation_id IN (${mine})`;
    default: return null;
  }
}

// Media pull scoping (#29-H): message attachments are private to the message's
// conversation — a media row linked to a message the caller cannot see must not
// sync down to their device. Non-message media (items, jobs, locations, …) stays
// unscoped: that is the normal shared media surface. Same subquery shape as
// chatScopeSql, parameterized on the caller id via `callerParam`.
function mediaScopeSql(callerParam: string): string {
  const mine = `SELECT conversation_id FROM conversation_participants WHERE user_id = ${callerParam}`;
  return `(entity_type != 'message' OR entity_id IN (SELECT id FROM messages WHERE conversation_id IN (${mine})))`;
}

// #84: may a caller WITHOUT manage_locations INSERT this locations row? Only
// when the org has opted in (app_config crew_add_vehicle_enabled = '1' —
// system_settings-gated, read server-side like maintenance_mode) AND the row
// resolves to a Vehicle-type location (label, or type_id when the label is
// absent). Fails closed on any lookup error — this is an exemption, not a right.
async function crewVehicleInsertAllowed(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { rows } = await pg.query(
      `SELECT value FROM app_config WHERE key = 'crew_add_vehicle_enabled'`, [],
    );
    if (!rows[0] || (rows[0] as { value: string }).value !== '1') return false;
    if (payload.type != null) return String(payload.type) === 'Vehicle';
    if (payload.type_id != null) {
      const { rows: t } = await pg.query(
        `SELECT 1 FROM taxonomy_types WHERE id = $1 AND category = 'location_type' AND label = 'Vehicle'`,
        [payload.type_id],
      );
      return !!t[0];
    }
    return false;
  } catch {
    return false;
  }
}

// May a caller WITHOUT manage_locations INSERT this locations row as a Shelf?
// A stock recount/add auto-creates a Shelf under the location being counted, so
// a checkin_inventory/checkout_inventory holder (checked at the call site via
// `can` — this only resolves the row's type) must be able to land the Shelf row
// itself: without this the shelf INSERT is Forbidden-dropped client-side and
// the follow-up stock_by_location INSERT referencing it FK-violates forever.
// Only Shelf-type rows qualify (label, or type_id when the label is absent) —
// every other locations write stays behind manage_locations. Fails closed on
// any lookup error — this is an exemption, not a right.
async function crewShelfInsertAllowed(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (payload.type != null) return String(payload.type) === 'Shelf';
    if (payload.type_id != null) {
      const { rows: t } = await pg.query(
        `SELECT 1 FROM taxonomy_types WHERE id = $1 AND category = 'location_type' AND label = 'Shelf'`,
        [payload.type_id],
      );
      return !!t[0];
    }
    return false;
  } catch {
    return false;
  }
}

// Resolve the caller's relationship to a conversation for the chat write guards
// (lib/chatPolicy.ts decides; this only gathers facts). Fails closed: a missing
// row, a null id, or a malformed uuid (the cast throws) all come back as
// "doesn't exist", which the policy rejects with the transient wording.
async function conversationFacts(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  conversationId: unknown,
  callerId: string,
): Promise<ChatConversationFacts> {
  try {
    const { rows } = await pg.query(
      `SELECT (c.created_by = $2) AS is_creator,
              EXISTS (SELECT 1 FROM conversation_participants cp
                       WHERE cp.conversation_id = c.id AND cp.user_id = $2) AS is_participant
         FROM conversations c WHERE c.id = $1`,
      [conversationId, callerId],
    );
    const r = rows[0] as { is_creator: boolean | null; is_participant: boolean } | undefined;
    if (!r) return { exists: false, isCreator: false, isParticipant: false };
    return { exists: true, isCreator: r.is_creator === true, isParticipant: r.is_participant === true };
  } catch {
    return { exists: false, isCreator: false, isParticipant: false };
  }
}

// Team tables are scoped to the teams the caller belongs to. Like the chat tables,
// this cannot be expressed by the single-column SCOPED_TABLES map: scoping
// team_members on `user_id` would show a device only its OWN membership row rather
// than its teammates' — the same trap chatScopeSql exists to avoid for
// conversation_participants. So it is a subquery, keyed on the caller's memberships.
//
//   teams        → the teams I belong to
//   team_members → every member of the teams I belong to (my teammates, not just me)
//   jobs         → my teams' jobs, PLUS every unassigned job (team_id IS NULL is
//                  "org-wide"; every job predates migration 043 and is NULL, so this
//                  returns exactly today's set until jobs are actually assigned)
//
// Only applied when the caller may NOT see all teams — see canSeeAllTeams below.
function teamScopeSql(table: string, callerParam: string): string | null {
  const mine = `SELECT team_id FROM team_members WHERE user_id = ${callerParam}`;
  switch (table) {
    case 'teams': return `id IN (${mine})`;
    case 'team_members': return `team_id IN (${mine})`;
    case 'jobs': return `(team_id IS NULL OR team_id IN (${mine}))`;
    // Crews of my teams (mirrors team_members). vehicles/service records/
    // checkouts/locker_access/on_call stay UNSCOPED deliberately: fast checkout
    // needs teammates' assets locally, and none of those rows are secret.
    case 'subteams': return `team_id IN (${mine})`;
    default: return null;
  }
}

// May this caller see every team's data? Tier 3+ (office_manager, hr_manager,
// franchise_manager) and full_admin (apex, tier 5) — see lib/teamAuthority.
//
// NOT gated on view_all_logs/manage_teams: tier 2 (production_manager,
// head_of_construction, …) holds BOTH, so that gate would scope only tier-1 crew
// and still hand every crew lead the whole org's rosters and permission overrides.
// A tier check also cannot be re-opened by a stray runtime permission override.
function canSeeAllTeams(caller: { role: string }): boolean {
  return isOrgAuthority(caller.role);
}

function conflictTarget(table: string): string {
  return CONFLICT_TARGETS[table] ?? 'id';
}

function keyColumns(table: string): string[] {
  return conflictTarget(table).split(',').map(s => s.trim());
}

const FULL_TABLES = [
  'role_settings', 'users', 'locations', 'inventory_items',
  'stock_by_location', 'jobs', 'teams', 'team_members', 'media',
  'equipment_units', 'app_config', 'taxonomy_types', 'repairs', 'repair_parts',
  'notifications', 'approval_requests', 'maintenance_events', 'label_templates',
  'dashboard_presets',
  'conversations', 'conversation_participants', 'messages',
  'user_prefs',
  'subteams', 'vehicles', 'vehicle_service_records', 'vehicle_checkouts',
  'locker_access', 'on_call_shifts', 'unit_access', 'on_call_coverage',
  // Job assignments (#160): unscoped like vehicle_checkouts — a crew device
  // needs its subteam's assignments locally and none of the columns are secret
  // (the job rows themselves stay team-scoped via teamScopeSql above).
  'job_assignments',
];

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

async function applyEntry(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
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
    // Attribute to the AUTHENTICATED caller, not the client-supplied user_id —
    // otherwise any token could forge audit entries blaming another user.
    // (created_at stays client-supplied: offline events carry their real time.)
    //
    // Deliberately NOT stamped with metadata.request_id (unlike the server-written
    // login/pin_set rows in auth.ts). These rows were created on-device, possibly
    // days earlier while offline, and merely happen to be carried by THIS push —
    // correlating them to it would assert a causal link that does not exist. Only
    // server-written activity correlates to the request that produced it.
    // A reference the server doesn't have must never cost us the audit row (#56).
    // The commonest cause is authorization: the user lacked the permission for the
    // underlying write, so that entity's INSERT was permanently rejected and the
    // client dropped it — leaving this row pointing at a job/team/location that
    // exists nowhere on the server. Left alone, the FK (or a non-uuid entity_id)
    // raises, applyEntry throws, and the generic 'write rejected' sends the client
    // into a retry-to-dead-letter loop that silently erases the entry. So: null the
    // unresolvable column, keep the id under metadata.orphaned_refs, record the row.
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
        payload.device_id ?? null, payload.created_at,
        payload.latitude ?? null, payload.longitude ?? null, payload.location_accuracy ?? null,
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
    // whole batch commits (see the /sync/push loop) so paired transfer legs have
    // all landed and re-arm works regardless of delta sign.
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
    // a losing claim is coerced to false. Today's only client UPDATE touching
    // is_primary is the move feature, which always clears it, so this is a no-op
    // for current flows; it closes the path rather than trusting them to stay so.
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
  // table on the set's definition; approval_requests also has the force-open
  // block above).
  const sql = updates && !INSERT_NO_UPSERT.has(table_name)
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

// Resolve the caller's *current* role + permission overrides from the DB — not
// the JWT role claim, which can be stale or forged-stale within the 15m token
// window. Shared by /full, /pull, and /push so all three authorize identically.
async function resolveCaller(
  pg: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  userId: string,
): Promise<
  | { role: string; permission_overrides: Record<string, boolean> | null; role_overrides: Record<string, boolean> | null; is_test: boolean }
  | undefined
> {
  const { rows } = await pg.query(
    `SELECT u.role, u.permission_overrides, u.is_test, rs.permission_overrides AS role_overrides
       FROM users u
       LEFT JOIN role_settings rs ON rs.role = u.role
      WHERE u.id = $1`,
    [userId],
  );
  return rows[0] as
    | { role: string; permission_overrides: Record<string, boolean> | null; role_overrides: Record<string, boolean> | null; is_test: boolean }
    | undefined;
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Boot-time column introspection — the allowlist of real identifiers per table.
  const realColumns = await loadTableColumns(fastify.pg, [...ALLOWED_TABLES]);

  // GET /sync/full — first-launch paginated full download
  fastify.get<{
    Querystring: { table?: string; page?: string; limit?: string }
  }>('/full', {
    preHandler: [(fastify as any).authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          table: { type: 'string', enum: FULL_TABLES },
          // Coerced + bounded; the handler still parseInt()s and caps limit at 500.
          page: { type: 'integer', minimum: 0, maximum: 1000000 },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const sub = (request.user as { sub?: string })?.sub ?? '';
    // First-launch download pages EVERY full table 500 rows at a time, sequentially
    // (fullDownload.ts) — a real org bursts to dozens/hundreds of requests, and a 429
    // aborts enrollment (not retried). Keep the ceiling generous; per-page DB writes on
    // the client already throttle the true rate. Still bounds a malicious dump loop.
    if (overLimit('syncfull:' + sub, 300)) return reply.status(429).send({ error: 'rate' });
    const { table, page = '0', limit = '500' } = request.query;
    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 500);
    const offset = pageNum * limitNum;

    if (!table || !FULL_TABLES.includes(table)) {
      return reply.status(400).send({ error: 'Invalid table' });
    }

    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const canViewFinancial = userHasPermission(caller.role, caller.permission_overrides, 'view_financial_data', caller.role_overrides);

    // Scoped tables (e.g. notifications) only ever return the caller's own rows;
    // chat tables are scoped to the caller's own conversations (chatScopeSql); team
    // tables to the caller's own teams (teamScopeSql), unless they may see all teams.
    // NOTE the caller id is $3 here ($1 = limit, $2 = offset) but $2 in /sync/pull.
    const scopeCol = SCOPED_TABLES[table];
    const chatScope = chatScopeSql(table, '$3');
    const mediaScope = table === 'media' ? mediaScopeSql('$3') : null;
    const teamScope = canSeeAllTeams(caller) ? null : teamScopeSql(table, '$3');
    const scopeSql = scopeCol ? ` WHERE ${scopeCol} = $3`
      : chatScope ? ` WHERE ${chatScope}`
      : mediaScope ? ` WHERE ${mediaScope}`
      : teamScope ? ` WHERE ${teamScope}` : '';
    const scoped = !!scopeCol || !!chatScope || !!mediaScope || !!teamScope;
    const { rows } = await fastify.pg.query(
      `SELECT ${selectColumnsFor(table, canViewFinancial)} FROM ${table}${scopeSql} ORDER BY 1 LIMIT $1 OFFSET $2`,
      scoped ? [limitNum + 1, offset, userId] : [limitNum + 1, offset]
    );

    const hasMore = rows.length > limitNum;
    return { rows: (rows as Record<string, unknown>[]).slice(0, limitNum), hasMore };
  });

  // GET /sync/pull — incremental changes since timestamp
  fastify.get<{
    Querystring: { since?: string }
  }>('/pull', {
    preHandler: [(fastify as any).authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          // ISO timestamp watermark; defaults to epoch when omitted.
          since: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const sub = (request.user as { sub?: string })?.sub ?? '';
    // Incremental pull fires on poll + after each write; bulk-entry sessions can
    // coalesce many syncs. 120/min matches the global mutation ceiling — abuse-safe
    // without throttling a busy offline-first client catching up.
    if (overLimit('syncpull:' + sub, 120)) return reply.status(429).send({ error: 'rate' });
    const since = request.query.since ?? new Date(0).toISOString();
    const results: Record<string, { rows: unknown[] }> = {};

    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const canViewFinancial = userHasPermission(caller.role, caller.permission_overrides, 'view_financial_data', caller.role_overrides);

    for (const table of FULL_TABLES) {
      // media used created_at here until migration 044 added updated_at (backfilled
      // = created_at, so watermarks were preserved). With the cursor on updated_at,
      // media EDITS (caption/location_note/move) finally propagate incrementally.
      const dateCol = 'updated_at';
      // Scoped tables (e.g. notifications) only ever return the caller's own rows;
      // chat tables are scoped to the caller's own conversations (chatScopeSql); team
      // tables to the caller's own teams (teamScopeSql), unless they may see all teams.
      // NOTE the caller id is $2 here ($1 = since) but $3 in /sync/full.
      const scopeCol = SCOPED_TABLES[table];
      const chatScope = chatScopeSql(table, '$2');
      const mediaScope = table === 'media' ? mediaScopeSql('$2') : null;
      const teamScope = canSeeAllTeams(caller) ? null : teamScopeSql(table, '$2');
      const scopeSql = scopeCol ? ` AND ${scopeCol} = $2`
        : chatScope ? ` AND ${chatScope}`
        : mediaScope ? ` AND ${mediaScope}`
        : teamScope ? ` AND ${teamScope}` : '';
      const scoped = !!scopeCol || !!chatScope || !!mediaScope || !!teamScope;
      const { rows } = await fastify.pg.query(
        `SELECT ${selectColumnsFor(table, canViewFinancial)} FROM ${table} WHERE ${dateCol} > $1${scopeSql}`,
        scoped ? [since, userId] : [since]
      );
      results[table] = { rows };
    }

    return results;
  });

  // POST /sync/push — apply device outbox entries
  fastify.post<{ Body: PushBody }>('/push', {
    preHandler: [(fastify as any).authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['entries'],
        properties: {
          entries: { type: 'array', items: { type: 'object' }, maxItems: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { entries } = request.body;
    const ok: string[] = [];
    const conflicts: Array<{ id: string; error: string }> = [];
    // #129: merge map + response for duplicate Vehicle-typed location INSERTs.
    const merged: Array<{ id: string; duplicate_id: string; survivor_id: string }> = [];
    const vehicleAlias = new Map<string, string>(); // duplicate location id -> survivor id

    // Resolve the caller's *current* permissions from the DB — not the JWT role
    // claim, which can be stale or forged-stale within the 15m token window.
    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const can = (perm: string) =>
      userHasPermission(caller.role, caller.permission_overrides, perm, caller.role_overrides);

    // Server-side maintenance freeze: when on, only admins (system_settings) may
    // write — mirrors the client's assertWritable() so a device with queued
    // outbox entries can't push past an admin's freeze.
    const { rows: mRows } = await fastify.pg.query(
      `SELECT value FROM app_config WHERE key = 'maintenance_mode'`,
      [],
    );
    const maintenanceOn = !!mRows[0] && (mRows[0] as { value: string }).value === '1';
    const maintenanceExempt = can('system_settings');
    const touchedItems = new Set<string>(); // items adjusted this batch (low-stock check runs post-batch)

    for (const entry of entries) {
      if (!ALLOWED_TABLES.has(entry.table_name)) {
        // A write aimed at a table outside the allowlist is a crafted payload, not
        // a client typo — flag the request for the audit trail (see outcomeFor).
        (request as unknown as { auditInjectionAttempt?: boolean }).auditInjectionAttempt = true;
        request.log.warn(
          { userId: (request.user as { sub?: string })?.sub, table: entry.table_name, operation: entry.operation },
          'sync push entry rejected (table not allowlisted)',
        );
        conflicts.push({ id: entry.id, error: 'Table not allowed' });
        continue;
      }

      // Test/demo accounts are sandbox-only. This sits ABOVE every other branch
      // (including the system_settings maintenance exemption) so not even the
      // full_admin demo account can write anything through sync.
      if (caller.is_test) {
        conflicts.push({ id: entry.id, error: TEST_ACCOUNT_WRITE_ERROR });
        continue;
      }

      if (maintenanceOn && !maintenanceExempt) {
        conflicts.push({ id: entry.id, error: 'Maintenance mode: writes are frozen' });
        continue;
      }

      // Privileged-table authorization — block escalation via crafted outbox rows.
      const reqPerm = PRIVILEGED_TABLE_PERM[entry.table_name];
      if (reqPerm && !can(reqPerm)) {
        request.log.warn(
          { userId, role: caller.role, table: entry.table_name, operation: entry.operation, reqPerm },
          'sync push entry denied (authz)',
        );
        conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name} requires ${reqPerm}` });
        continue;
      }

      // demo_mode (#32 S3) is the apex-only demo-account kill switch — it is
      // toggled only through its dedicated guarded path, never via generic
      // app_config sync (system_settings alone must not flip it). "Forbidden"
      // wording marks the rejection permanent to the mobile sync engine
      // (matches /forbidden|cannot|not allowed/i — see TEST_ACCOUNT_WRITE_ERROR).
      if (entry.table_name === 'app_config' && entry.payload.key === 'demo_mode') {
        request.log.warn(
          { userId, role: caller.role, operation: entry.operation },
          'sync push app_config demo_mode denied',
        );
        conflicts.push({ id: entry.id, error: 'Forbidden: demo_mode cannot be changed via sync' });
        continue;
      }

      // Tier guard for role_settings (security-critical): editing a role's
      // permission matrix is "acting on" that role. The edited role is the row's
      // conflict key (payload.role). A caller may only edit permissions for a role
      // at or below their own tier (apex full_admin's row only editable by a
      // full_admin). Fails closed on unknown roles.
      if (entry.table_name === 'role_settings') {
        const editedRole = entry.payload.role;
        if (!canActOnTarget(caller.role, editedRole == null ? null : String(editedRole))) {
          request.log.warn(
            { userId, role: caller.role, editedRole },
            'sync push role_settings denied (tier guard)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: cannot edit permissions for a role at or above your level' });
          continue;
        }

        // Only a full_admin may grant/revoke the destructive delete permissions
        // (mirrors the client lock in roles.tsx). Compare each guarded bit in the
        // incoming overrides against the stored row; deny a CHANGE by a non-apex
        // caller. Other permission edits on the role are unaffected.
        if (caller.role !== 'full_admin') {
          const parseOv = (v: unknown): Record<string, unknown> => {
            if (v == null) return {};
            if (typeof v === 'string') { try { return JSON.parse(v) as Record<string, unknown>; } catch { return {}; } }
            return typeof v === 'object' ? (v as Record<string, unknown>) : {};
          };
          const incoming = parseOv(entry.payload.permission_overrides);
          const { rows: curRows } = await fastify.pg.query<{ permission_overrides: unknown }>(
            `SELECT permission_overrides FROM role_settings WHERE role = $1`,
            [String(editedRole)],
          );
          const current = parseOv(curRows[0]?.permission_overrides);
          const guarded = ['delete_inventory', 'delete_media'].find(perm => {
            const incHas = perm in incoming;
            const curHas = perm in current;
            return incHas !== curHas || (incHas && incoming[perm] !== current[perm]);
          });
          if (guarded) {
            request.log.warn(
              { userId, role: caller.role, editedRole, perm: guarded },
              'sync push role_settings destructive-grant denied (not full_admin)',
            );
            conflicts.push({ id: entry.id, error: `Forbidden: only a full admin can grant or revoke the ${guarded} permission` });
            continue;
          }
        }
      }

      // Privileged rows are never DELETED via sync: users deactivate (active=false),
      // not delete; roles/config persist. Without this, a manage_users holder (e.g. a
      // tier-3 hr_manager) could remove a full_admin row via a crafted DELETE entry —
      // a capability the REST API deliberately never exposes.
      if (entry.operation === 'DELETE' && DELETE_FORBIDDEN_TABLES.has(entry.table_name)) {
        conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name} cannot be deleted via sync` });
        continue;
      }

      // Operational-table authorization — gate writes on the per-operation
      // permission. ADJUST is the signed-delta checkout/checkin path on
      // stock_by_location; it requires checkin_inventory or checkout_inventory
      // rather than the generic op-perm map (any authenticated user was
      // previously able to mutate stock via ADJUST — closed here).
      if (entry.operation === 'ADJUST') {
        if (!can('checkin_inventory') && !can('checkout_inventory')) {
          request.log.warn(
            { userId, role: caller.role, table: entry.table_name, operation: entry.operation },
            'sync push ADJUST denied (authz)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: stock adjust requires checkin/checkout permission' });
          continue;
        }
        // Hard locker enforcement (#126, user decision 2026-07-18): a NEGATIVE
        // delta (taking stock) from a Locker-typed location is allowed only for
        // the owner ∪ an explicit locker_access grantee ∪ someone who shares a
        // TEAM with the owner ∪ org authority (tier 3+, checked first so the
        // lookup is skipped). Positive deltas (restocking a locker) stay open,
        // and non-Locker locations are untouched. The rejection wording matches
        // /forbidden|cannot|not allowed/i so the mobile engine classifies it
        // permanent and DROPS the entry (an offline-revoked checkout must not
        // retry-loop — accepted race, the activity log still records it).
        const adjDelta = Number((entry.payload as { delta?: unknown }).delta);
        if (Number.isFinite(adjDelta) && adjDelta < 0 && !isOrgAuthority(caller.role)) {
          let lockerDenied = false;
          try {
            const { rows: lockRows } = await fastify.pg.query(
              `SELECT l.type,
                      (l.owner_user_id = $2) AS is_owner,
                      EXISTS (SELECT 1 FROM locker_access la
                               WHERE la.location_id = l.id AND la.user_id = $2) AS has_grant,
                      EXISTS (SELECT 1 FROM team_members om
                                JOIN team_members cm ON cm.team_id = om.team_id
                               WHERE om.user_id = l.owner_user_id AND cm.user_id = $2) AS shares_team
                 FROM locations l WHERE l.id = $1`,
              [entry.payload.location_id, userId],
            );
            const lock = lockRows[0] as
              | { type: string | null; is_owner: boolean | null; has_grant: boolean; shares_team: boolean }
              | undefined;
            lockerDenied = !!lock && lock.type === 'Locker'
              && lock.is_owner !== true && !lock.has_grant && !lock.shares_team;
          } catch {
            // Lookup failure is transient — surface a NON-permanent conflict so
            // the entry retries instead of being silently dropped.
            conflicts.push({ id: entry.id, error: 'locker access check failed' });
            continue;
          }
          if (lockerDenied) {
            request.log.warn(
              { userId, role: caller.role, locationId: entry.payload.location_id, delta: adjDelta },
              'sync push ADJUST denied (locker access)',
            );
            conflicts.push({ id: entry.id, error: 'Forbidden: you do not have access to this locker' });
            continue;
          }
        }
      } else if (entry.table_name === 'inventory_items' && entry.operation === 'UPDATE' && entry.payload.active === false) {
        // Deactivating an item IS the delete (items are soft-deleted, never row-
        // deleted). The generic UPDATE op-perm is only `edit_inventory`, so gate
        // the active:false case on the stricter `delete_inventory` — otherwise the
        // UI's delete gate would be advisory-only and an edit_inventory-only role
        // could deactivate items via a crafted push.
        if (!can('delete_inventory')) {
          conflicts.push({ id: entry.id, error: 'Forbidden: deactivating an item requires delete_inventory' });
          continue;
        }
      } else {
        const opPerm = requiredOperationPerm(entry.table_name, entry.operation as 'INSERT' | 'UPDATE' | 'DELETE');
        if (opPerm === 'DENY') {
          conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name}/${entry.operation} not permitted via sync` });
          continue;
        }
        if (opPerm && !can(opPerm)) {
          // #84: a crew member without manage_locations may still INSERT a
          // location when the org flag is on AND the row is a Vehicle ("add a
          // vehicle" from the fast-checkout source picker). Everything else
          // stays gated exactly as before.
          const crewVehicleOk = entry.table_name === 'locations' && entry.operation === 'INSERT'
            && await crewVehicleInsertAllowed(fastify.pg, entry.payload);
          // A stock-mover (checkin/checkout) may INSERT the auto-created Shelf
          // a recount/add lands on — see crewShelfInsertAllowed. Everything
          // else stays gated exactly as before.
          const crewShelfOk = !crewVehicleOk
            && entry.table_name === 'locations' && entry.operation === 'INSERT'
            && (can('checkin_inventory') || can('checkout_inventory'))
            && await crewShelfInsertAllowed(fastify.pg, entry.payload);
          if (!crewVehicleOk && !crewShelfOk) {
            request.log.warn(
              { userId, role: caller.role, table: entry.table_name, operation: entry.operation, opPerm },
              'sync push op denied (authz)',
            );
            conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name}/${entry.operation} requires ${opPerm}` });
            continue;
          }
        }
      }

      // Target-role guard for users writes: applyWritePolicy above already gates
      // WHICH columns a manage_users-only caller may set, but not WHOSE row. A
      // manage_users holder without manage_roles_permissions must not be able to
      // deactivate/expire a full_admin/franchise_manager via a crafted outbox
      // entry — REST PATCH /users/:id already blocks the equivalent via
      // PRIVILEGED_ROLES (apps/api/src/routes/users.ts). DELETE on users is
      // already unconditionally forbidden above; INSERT is an upsert
      // (ON CONFLICT DO UPDATE) so it must be guarded too, not just UPDATE.
      if (entry.table_name === 'users' && (entry.operation === 'UPDATE' || entry.operation === 'INSERT')) {
        const targetId = entry.payload.id;
        const { rows: targetRows } = await fastify.pg.query(
          `SELECT role, active FROM users WHERE id = $1`,
          [targetId],
        );
        const target = targetRows[0] as { role: string; active: boolean } | undefined;
        if (target) {
          if (requiresRolesPermForTarget(target.role) && !can('manage_roles_permissions')) {
            request.log.warn(
              { userId, role: caller.role, targetId, targetRole: target.role },
              'sync push users update denied (target-role guard)',
            );
            conflicts.push({ id: entry.id, error: 'Forbidden: target user has a privileged role; requires roles & permissions' });
            continue;
          }
          // Tier guard (security-critical): the caller must be at or above the
          // target's tier to touch their row at all (apex full_admin only touchable
          // by a full_admin). Fails closed on unknown roles.
          if (!canActOnTarget(caller.role, target.role)) {
            request.log.warn(
              { userId, role: caller.role, targetId, targetRole: target.role },
              'sync push users write denied (tier guard)',
            );
            conflicts.push({ id: entry.id, error: 'Forbidden: target user is at or above your level' });
            continue;
          }
          // Assigning/changing the role: the NEW role must also be at or below the
          // caller's tier — no promoting anyone up to (or past) your own level.
          if (entry.payload.role != null && !canAssignRole(caller.role, String(entry.payload.role))) {
            request.log.warn(
              { userId, role: caller.role, targetId, newRole: entry.payload.role },
              'sync push users role-assign denied (tier guard)',
            );
            conflicts.push({ id: entry.id, error: 'Forbidden: cannot assign a role at or above your level' });
            continue;
          }
          // "Deactivating" = explicit active:false OR pushing expires_at into the
          // past (login enforces expires_at, so a past date locks the account out).
          const exp = entry.payload.expires_at;
          const expiredOut = exp != null && !Number.isNaN(Date.parse(String(exp))) && new Date(String(exp)) < new Date();
          const deactivating = entry.payload.active === false || expiredOut;
          if (deactivating && targetId === userId) {
            conflicts.push({ id: entry.id, error: 'Forbidden: you cannot deactivate your own account' });
            continue;
          }
          if (deactivating && target.active && target.role === 'full_admin') {
            const { rows: activeAdminRows } = await fastify.pg.query(
              `SELECT COUNT(*)::int AS n FROM users WHERE role = 'full_admin' AND active = true`,
              [],
            );
            const activeAdminCount = (activeAdminRows[0] as { n: number }).n;
            if (activeAdminCount <= 1) {
              conflicts.push({ id: entry.id, error: 'Forbidden: cannot deactivate the last active full_admin' });
              continue;
            }
          }
        } else if (entry.operation === 'INSERT') {
          // No existing row (fresh UUID INSERT): the `if (target)` checks above
          // were all skipped, so the role-assignment tier guard never ran — a
          // manage_users-only caller could otherwise mint an apex full_admin by
          // INSERTing a brand-new users row. Enforce the assign-tier check here.
          if (entry.payload.role != null && !canAssignRole(caller.role, String(entry.payload.role))) {
            request.log.warn(
              { userId, role: caller.role, targetId, newRole: entry.payload.role },
              'sync push users insert role-assign denied (tier guard)',
            );
            conflicts.push({ id: entry.id, error: 'Forbidden: cannot assign a role at or above your level' });
            continue;
          }
        }
      }

      // media: entity-linkage guard (pure rules in syncPolicy.validateMediaWrite).
      // INSERT must attach to an allowlisted entity type (the REST upload path
      // always enforced this; the sync path didn't). UPDATE may re-link (the
      // "move" feature) only to a job — and the target job must actually exist,
      // checked here where pg lives.
      if (entry.table_name === 'media' && (entry.operation === 'INSERT' || entry.operation === 'UPDATE')) {
        const mediaErr = validateMediaWrite(entry.operation, entry.payload);
        if (mediaErr) {
          request.log.warn({ userId, operation: entry.operation }, 'sync push media write denied (entity linkage)');
          conflicts.push({ id: entry.id, error: `Forbidden: ${mediaErr}` });
          continue;
        }
        if (entry.operation === 'UPDATE' && entry.payload.entity_id !== undefined) {
          const { rows: jobRows } = await fastify.pg.query(
            `SELECT 1 FROM jobs WHERE id = $1`, [entry.payload.entity_id],
          );
          if (!jobRows[0]) {
            conflicts.push({ id: entry.id, error: 'Forbidden: target job does not exist' });
            continue;
          }
        }
      }

      // media DELETE: capture the row BEFORE applyEntry removes it, so the
      // MinIO object cleanup after a successful delete has the url/thumbnail
      // to work from. Cleanup itself is fire-and-forget below — the sync-path
      // delete used to orphan every object (only the unused REST route cleaned).
      let mediaRowForCleanup: { id: string; url: string; thumbnail_url: string | null } | null = null;
      if (entry.table_name === 'media' && entry.operation === 'DELETE') {
        const { rows: mediaRows } = await fastify.pg.query(
          `SELECT id, url, thumbnail_url FROM media WHERE id = $1`, [entry.payload.id],
        );
        mediaRowForCleanup = (mediaRows[0] as { id: string; url: string; thumbnail_url: string | null } | undefined) ?? null;
      }

      // notifications are per-user inbox rows: clients may only UPDATE (mark read),
      // never INSERT/DELETE (op-perm already denies those), and only their OWN row.
      // A crafted entry claiming another user's row (payload.user_id != caller) is
      // rejected here; the only client-writable column is read_at (SENSITIVE_DENY).
      if (entry.table_name === 'notifications') {
        if (entry.operation !== 'UPDATE') {
          conflicts.push({ id: entry.id, error: 'Forbidden: notifications are read-only except marking read' });
          continue;
        }
        const targetUser = entry.payload.user_id;
        if (targetUser != null && String(targetUser) !== userId) {
          conflicts.push({ id: entry.id, error: 'Forbidden: cannot modify another user\'s notification' });
          continue;
        }
      }

      // messages: a user may only post to a conversation they PARTICIPATE in.
      // sender_id is forced to the caller by ATTRIBUTION_COLUMNS, so we only need
      // to authorize the target conversation. Verified server-side (the scoped
      // pull already hides non-member conversations, but a crafted push must still
      // be rejected).
      if (entry.table_name === 'messages' && entry.operation === 'INSERT') {
        const convId = entry.payload.conversation_id;
        const { rows: partRows } = await fastify.pg.query(
          `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
          [convId, userId],
        );
        if (!partRows[0]) {
          request.log.warn(
            { userId, conversationId: convId },
            'sync push message denied (not a participant)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: not a participant of this conversation' });
          continue;
        }
      }

      // messages UPDATE: no client flow edits messages today, so fail closed to
      // the sender — otherwise any participant could rewrite another member's
      // message body via a crafted UPDATE (sender_id itself is attribution-
      // protected, but body is not). The INSERT-with-existing-id variant of the
      // same rewrite is closed by INSERT_NO_UPSERT.
      if (entry.table_name === 'messages' && entry.operation === 'UPDATE') {
        let senderId: string | undefined;
        try {
          const { rows: msgRows } = await fastify.pg.query(
            `SELECT sender_id FROM messages WHERE id = $1`,
            [entry.payload.id],
          );
          senderId = (msgRows[0] as { sender_id: string } | undefined)?.sender_id;
        } catch { senderId = undefined; }
        if (senderId == null || String(senderId) !== userId) {
          request.log.warn(
            { userId, messageId: entry.payload.id },
            'sync push message update denied (not the sender)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: only the sender can edit a message' });
          continue;
        }
        // Soft-delete (#29): a deleted message must never retain its content —
        // force the body blank server-side rather than trusting the client to
        // have cleared it.
        if (entry.payload.deleted_at != null) entry.payload.body = '';
      }

      // conversation_participants: an INSERT is how a user BECOMES a member, so
      // an unguarded one lets anyone add themselves to any conversation and pull
      // its entire history. Rules live in lib/chatPolicy.ts; the facts are fresh
      // per entry because a batch may create the conversation earlier in this
      // same push (entries apply sequentially in outbox order, so the
      // conversations row — created_by forced to the caller — is already visible
      // when its participant rows arrive).
      if (
        entry.table_name === 'conversation_participants' &&
        (entry.operation === 'INSERT' || entry.operation === 'UPDATE' || entry.operation === 'DELETE')
      ) {
        const facts = await conversationFacts(fastify.pg, entry.payload.conversation_id, userId);
        const targetUser = entry.payload.user_id == null ? null : String(entry.payload.user_id);
        const verdict = participantWriteAllowed(entry.operation, targetUser, userId, facts);
        if (!verdict.allowed) {
          request.log.warn(
            { userId, conversationId: entry.payload.conversation_id, targetUser, operation: entry.operation },
            'sync push participant write denied',
          );
          conflicts.push({ id: entry.id, error: verdict.error });
          continue;
        }
      }

      // conversations UPDATE: no client flow renames conversations today, so
      // fail closed to members — a non-participant must not retitle or re-kind
      // someone else's conversation. (created_by is attribution-protected, and
      // the INSERT-with-existing-id takeover is closed by INSERT_NO_UPSERT.)
      if (entry.table_name === 'conversations' && entry.operation === 'UPDATE') {
        const facts = await conversationFacts(fastify.pg, entry.payload.id, userId);
        if (!facts.isParticipant) {
          request.log.warn(
            { userId, conversationId: entry.payload.id },
            'sync push conversation update denied (not a participant)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: not a participant of this conversation' });
          continue;
        }
      }

      // Remap in-batch references from an already-merged duplicate vehicle to its
      // survivor, so the batch's follow-up rows (vehicles ext, stock, checkouts,
      // activity) land on the row the server actually kept.
      if (vehicleAlias.size > 0) {
        const refCols = ['location_id', 'vehicle_location_id', 'site_location_id', 'current_location_id', 'home_location_id', 'from_location_id', 'to_location_id', 'parent_id'];
        const cols = entry.table_name === 'locations' ? [...refCols, 'id'] : refCols;
        for (const col of cols) {
          const v = entry.payload[col];
          if (typeof v === 'string' && vehicleAlias.has(v)) entry.payload[col] = vehicleAlias.get(v);
        }
      }

      // No sub-areas under vehicles/lockers (#122 A1): migration 059 flattened the
      // existing ones; block re-creation. Parent type comes from the DB, never the
      // payload. Wording matches the mobile permanent-rejection regex.
      if (entry.table_name === 'locations'
          && (entry.operation === 'INSERT' || entry.operation === 'UPDATE')
          && entry.payload.parent_id != null) {
        let parentType: string | null = null;
        try {
          const { rows: pRows } = await fastify.pg.query(
            `SELECT type FROM locations WHERE id = $1`, [entry.payload.parent_id],
          );
          parentType = pRows[0] ? String((pRows[0] as { type: string | null }).type ?? '') : null;
        } catch { parentType = null; }
        if (parentType === 'Vehicle' || parentType === 'Locker') {
          conflicts.push({ id: entry.id, error: 'Forbidden: vehicles and lockers cannot contain sub-areas' });
          continue;
        }
      }

      // #129: server-side normalized-name uniqueness for Vehicle-typed locations.
      // A duplicate INSERT is MERGED into the existing row: the entry is ok'd (the
      // client outbox clears), nothing is inserted, and the dup id aliases to the
      // survivor for the rest of the batch + the merged[] response (the client
      // re-points its local rows — see mobile engine).
      if (entry.table_name === 'locations' && entry.operation === 'INSERT'
          && String(entry.payload.type ?? '') === 'Vehicle') {
        let survivorId: string | null = null;
        try {
          const { rows: dupRows } = await fastify.pg.query(
            `SELECT id FROM locations
              WHERE type = 'Vehicle' AND active = TRUE
                AND LOWER(TRIM(name)) = LOWER(TRIM($1)) AND id <> $2
              LIMIT 1`,
            [String(entry.payload.name ?? ''), entry.payload.id],
          );
          survivorId = dupRows[0] ? String((dupRows[0] as { id: string }).id) : null;
        } catch { survivorId = null; }
        if (survivorId) {
          vehicleAlias.set(String(entry.payload.id), survivorId);
          ok.push(entry.id);
          merged.push({ id: entry.id, duplicate_id: String(entry.payload.id), survivor_id: survivorId });
          continue;
        }
      }

      // subteams (#123): the manage_teams table gate above is not enough — a
      // tier-2 crew lead holds manage_teams but may only shape crews of a team
      // they actually MANAGE. resolveTeamAuthority (the teams source of truth):
      // org authority (tier 3+) OR is_manager of THAT team. The team id comes
      // from the payload when present (INSERT/UPDATE) or the existing row
      // (partial UPDATE / DELETE keyed on id); a subteam whose team cannot be
      // resolved fails closed with permanent wording.
      if (entry.table_name === 'subteams') {
        let teamId = entry.payload.team_id == null ? null : String(entry.payload.team_id);
        if (teamId == null) {
          try {
            const { rows: stRows } = await fastify.pg.query(
              `SELECT team_id FROM subteams WHERE id = $1`, [entry.payload.id],
            );
            teamId = stRows[0] ? String((stRows[0] as { team_id: string }).team_id) : null;
          } catch { teamId = null; }
        }
        if (teamId == null) {
          conflicts.push({ id: entry.id, error: 'Forbidden: subteam team could not be resolved' });
          continue;
        }
        const auth = await resolveTeamAuthority(fastify.pg, userId, teamId);
        if (!auth.orgAdmin && !auth.managerOnly) {
          request.log.warn(
            { userId, role: caller.role, teamId, operation: entry.operation },
            'sync push subteams denied (not a manager of this team)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: you do not manage this team' });
          continue;
        }
      }

      // locker_access (#126): these rows GRANT stock access (the ADJUST locker
      // guard trusts them), so writes are owner-or-org-authority only. The
      // owner is the DB's locations.owner_user_id — never the payload's — and
      // a grant against a location the server doesn't have fails closed with
      // permanent wording (the location itself was likely rejected upstream).
      if (entry.table_name === 'locker_access') {
        let ownerId: string | null = null;
        let locExists = false;
        try {
          const { rows: locRows } = await fastify.pg.query(
            `SELECT owner_user_id FROM locations WHERE id = $1`, [entry.payload.location_id],
          );
          if (locRows[0]) {
            locExists = true;
            ownerId = (locRows[0] as { owner_user_id: string | null }).owner_user_id;
          }
        } catch { locExists = false; }
        if (!locExists) {
          conflicts.push({ id: entry.id, error: 'Forbidden: unit location does not exist' });
          continue;
        }
        if (!isOrgAuthority(caller.role) && (ownerId == null || String(ownerId) !== userId)) {
          request.log.warn(
            { userId, role: caller.role, locationId: entry.payload.location_id, operation: entry.operation },
            'sync push locker_access denied (not the owner)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: only the unit owner can manage access' });
          continue;
        }
      }

      // unit_access (#122 Phase B): per-action grants gate vehicle/locker stock
      // access, so writes are owner ∪ manager-of-owner's-team ∪ production
      // manager ∪ tier-3+ — and every non-owner editor must out-tier the
      // GRANTEE (canManageUnitAccess, lib/unitAccessPolicy.ts). All facts come
      // from the DB, never the payload; a missing location fails closed with
      // permanent wording (matches the mobile engine's drop regex).
      if (entry.table_name === 'unit_access') {
        let uaFacts:
          | { owner_user_id: string | null; grantee_role: string | null; manages_owner_team: boolean }
          | undefined;
        try {
          const { rows: uaRows } = await fastify.pg.query(
            `SELECT l.owner_user_id,
                    (SELECT role FROM users WHERE id = $2) AS grantee_role,
                    EXISTS (SELECT 1 FROM team_members om
                              JOIN team_members cm ON cm.team_id = om.team_id AND cm.is_manager = TRUE
                             WHERE om.user_id = l.owner_user_id AND cm.user_id = $3) AS manages_owner_team
               FROM locations l WHERE l.id = $1`,
            [entry.payload.location_id, entry.payload.user_id, userId],
          );
          uaFacts = uaRows[0] as typeof uaFacts;
        } catch { uaFacts = undefined; }
        if (!uaFacts) {
          conflicts.push({ id: entry.id, error: 'Forbidden: unit location does not exist' });
          continue;
        }
        const allowed = canManageUnitAccess({
          callerId: userId,
          callerRole: caller.role,
          ownerUserId: uaFacts.owner_user_id == null ? null : String(uaFacts.owner_user_id),
          callerManagesOwnersTeam: uaFacts.manages_owner_team === true,
          granteeRole: uaFacts.grantee_role == null ? null : String(uaFacts.grantee_role),
        });
        if (!allowed) {
          request.log.warn(
            { userId, role: caller.role, locationId: entry.payload.location_id, operation: entry.operation },
            'sync push unit_access denied (not owner/team-manager/PM)',
          );
          conflicts.push({ id: entry.id, error: 'Forbidden: you cannot manage access to this unit' });
          continue;
        }
      }

      // vehicle_checkouts UPDATE (#125/#127): own row, OR manage_teams, OR the
      // close-only takeover — the payload sets ONLY checked_in_at on an OPEN
      // session (warn-and-take-over: any checkout_inventory holder may CLOSE a
      // stale session to take the vehicle, but may not edit its job/vehicle or
      // reopen it; user_id itself is attribution-protected, so the closed row
      // keeps its original holder). Row facts come from the DB, never the
      // payload; a missing row fails closed with permanent wording.
      if (entry.table_name === 'vehicle_checkouts' && entry.operation === 'UPDATE') {
        let vcRow: { user_id: string | null; checked_in_at: string | null } | undefined;
        try {
          const { rows: vcRows } = await fastify.pg.query(
            `SELECT user_id, checked_in_at FROM vehicle_checkouts WHERE id = $1`, [entry.payload.id],
          );
          vcRow = vcRows[0] as { user_id: string | null; checked_in_at: string | null } | undefined;
        } catch { vcRow = undefined; }
        if (!vcRow) {
          conflicts.push({ id: entry.id, error: 'Forbidden: vehicle checkout session does not exist' });
          continue;
        }
        const ownRow = vcRow.user_id != null && String(vcRow.user_id) === userId;
        if (!ownRow && !can('manage_teams')) {
          const touched = Object.keys(entry.payload)
            .filter(k => !['id', 'user_id', 'updated_at', 'synced_at', '__version'].includes(k));
          const closeOnly = vcRow.checked_in_at == null
            && entry.payload.checked_in_at != null
            && touched.length > 0
            && touched.every(k => k === 'checked_in_at');
          if (!closeOnly) {
            request.log.warn(
              { userId, role: caller.role, checkoutId: entry.payload.id },
              'sync push vehicle_checkouts update denied (not the holder)',
            );
            conflicts.push({ id: entry.id, error: 'Forbidden: cannot modify another user\'s vehicle checkout' });
            continue;
          }
        }
      }

      try {
        await applyEntry(fastify.pg, entry, userId, realColumns, can, touchedItems);
        ok.push(entry.id);
        // Media row deleted → best-effort MinIO object cleanup (shared with the
        // REST route; move-tolerant + table-wide refcount). Fire-and-forget:
        // never blocks or fails the sync write — a failed cleanup only leaves
        // an orphaned object, never data loss.
        if (mediaRowForCleanup) {
          const row = mediaRowForCleanup;
          void cleanupMediaObjects(fastify.pg, row).catch(err =>
            request.log.warn({ mediaId: row.id, err: (err as Error).message }, 'media object cleanup failed'),
          );
        }
        // New chat message → notify the OTHER participants, filtered by each one's
        // notify_pref vs the message urgency (messageRecipients). Fire-and-forget:
        // never blocks or fails the sync write. sender_id was forced to the caller.
        if (entry.table_name === 'messages' && entry.operation === 'INSERT') {
          const convId = entry.payload.conversation_id;
          const urgency = entry.payload.urgency === 'regular' ? 'regular' : 'urgent';
          const body = String(entry.payload.body ?? '');
          void (async () => {
            try {
              const { rows: parts } = await fastify.pg.query(
                `SELECT user_id, notify_pref FROM conversation_participants WHERE conversation_id = $1`,
                [convId],
              );
              const recipients = messageRecipients(
                parts as { user_id: string; notify_pref: string }[],
                userId,
                urgency,
              );
              if (!recipients.length) return;
              // Best-effort title: group title, else the sender's name.
              const { rows: cRows } = await fastify.pg.query(`SELECT kind, title FROM conversations WHERE id = $1`, [convId]);
              const { rows: uRows } = await fastify.pg.query(`SELECT name FROM users WHERE id = $1`, [userId]);
              const conv = cRows[0] as { kind: string; title: string | null } | undefined;
              const senderName = uRows[0] ? String((uRows[0] as { name: string }).name) : 'New message';
              const isGroup = conv?.kind === 'group';
              const title = isGroup && conv?.title ? conv.title : senderName;
              const pushBody = isGroup ? `${senderName}: ${body}` : body;
              await sendPush(fastify.pg, recipients, { title, body: pushBody, data: { screen: 'chat', conversationId: String(convId) } });
            } catch { /* never disrupt sync */ }
          })();
        }
      } catch (err) {
        // A rejected write of a forbidden/unknown column is a schema-probing
        // signal (not a benign conflict) — flag the request for the audit trail.
        if (err instanceof ForbiddenColumnsError) {
          (request as unknown as { auditInjectionAttempt?: boolean }).auditInjectionAttempt = true;
        }
        // Log the offending entry so a stuck/rejected outbox row is diagnosable
        // (the client only stores the reason locally; conflicts aren't otherwise
        // visible server-side). Include table + operation + payload keys.
        request.log.warn(
          {
            entryId: entry.id,
            table: entry.table_name,
            operation: entry.operation,
            payloadKeys: entry.payload ? Object.keys(entry.payload) : [],
            error: (err as Error).message,
          },
          'sync push entry rejected',
        );
        // A3: never echo the raw DB/error message to the client (it can leak
        // schema/constraint internals). The real error is logged server-side
        // above (request.log.warn) for diagnosis; the client gets a generic
        // reason so a rejected outbox entry still surfaces as a conflict.
        //
        // FK violation (Postgres 23503) is a genuine orphan — the referenced
        // row doesn't exist and never will (e.g. its INSERT was permanently
        // rejected), so retrying can never succeed. The wording must match the
        // mobile engine's permanent-rejection regex (/forbidden|cannot|not
        // allowed/i) so the entry dead-letters instead of retry-looping
        // forever. Every other error stays the generic (transient) wording.
        const isFkViolation = (err as { code?: string }).code === '23503';
        conflicts.push({
          id: entry.id,
          error: isFkViolation ? 'cannot apply: referenced row missing' : 'write rejected',
        });
      }
    }

    if (conflicts.length > 0) {
      request.log.warn({ count: conflicts.length }, 'sync push had conflicts');
    }

    // Low-stock notifications: one check per item touched by an ADJUST this batch,
    // AFTER every entry (incl. paired transfer legs) has committed. Fire-and-forget
    // — never delays the sync response. notifyLowStock re-arms + is idempotent.
    if (touchedItems.size > 0) {
      void (async () => {
        try {
          if (!(await getNotifyConfig(fastify.pg)).enabled) return;
          for (const itemId of touchedItems) await notifyLowStock(fastify.pg, itemId);
        } catch { /* never disrupt sync */ }
      })();
    }

    // Threshold auto-flag: any large (|qty| >= approval_threshold_qty) stock movement
    // committed this batch auto-files a review approval_request + notifies approvers.
    // Non-blocking — the movement already applied; this is a post-hoc review flag.
    // Deduped per source outbox op id so a retried push can't file duplicates.
    const okSet = new Set(ok);
    if (entries.some(e => okSet.has(e.id) && e.table_name === 'stock_by_location' && e.operation === 'ADJUST')) {
      void (async () => {
        try {
          const { rows: tRows } = await fastify.pg.query(`SELECT value FROM app_config WHERE key = 'approval_threshold_qty'`, []);
          const threshold = parseThreshold(tRows[0] ? (tRows[0] as { value: string }).value : undefined);
          if (!(threshold > 0)) return;
          for (const entry of entries) {
            if (!okSet.has(entry.id) || !isThresholdMovement(entry, threshold)) continue;
            // Dedup on the source op id: a retried push must not re-file the request.
            if (!(await claimEvent(fastify.pg, `approval:auto:${entry.id}`))) continue;
            const qty = Number((entry.payload as { delta?: unknown }).delta);
            const itemId = (entry.payload as { item_id?: unknown }).item_id ?? null;
            const locationId = (entry.payload as { location_id?: unknown }).location_id ?? null;
            let itemName = 'an item';
            try {
              const { rows: iRows } = await fastify.pg.query(`SELECT name FROM inventory_items WHERE id = $1`, [itemId]);
              if (iRows[0]) itemName = String((iRows[0] as { name: string }).name);
            } catch { /* name is best-effort */ }
            const reqId = randomUUID();
            const title = `Large movement: ${itemName} (${qty >= 0 ? '+' : ''}${qty})`;
            const metadata = JSON.stringify({ opId: entry.id, itemId, locationId, qty });
            await fastify.pg.query(
              `INSERT INTO approval_requests (id, requester_id, kind, title, status, entity_type, entity_id, metadata)
               VALUES ($1,$2,'threshold_checkout',$3,'open','item',$4,$5)`,
              [reqId, userId, title, itemId, metadata]);
            // Notify approvers (deduped on the new request id, mirroring the INSERT hook).
            if (await claimEvent(fastify.pg, dedupKeys.approval(reqId))) {
              const to = await resolveRecipients(fastify.pg, 'approvals', { userId });
              await deliver(fastify.pg, to, { type: 'approval_request', title: 'Approval requested', body: title, data: { screen: 'notifications', id: reqId }, createdBy: userId });
            }
          }
        } catch { /* never disrupt sync */ }
      })();
    }

    return { ok, conflicts, merged };
  });
};

export default routes;
