import { View, Text, StyleSheet } from 'react-native';
import { getLogForEntity } from '../db/queries/log';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useDbQuery } from '@invenpro/core';

// Ported from apps/mobile/src/components/ActivityFeed.tsx (236 ln). Slimmed:
// the old component's trailing photo thumbnail + full-screen lightbox
// (getPrimaryMedia/getMediaForEntity, Image/Modal/ScrollView pager) is CUT —
// src/db/queries/media.ts / the media domain isn't ported to mobile-v2 yet
// (TODO(wave-media), matches the cut already made in ItemCard.tsx and
// locations/[id].tsx's Photos section). Everything else — the icon/label/
// user/qty/note/date row rendering — is a straight port.
//
// Reactivity: the old screen re-read on a manual useTableVersion(['activity_log',
// 'media']) hook; mobile-v2 uses the same idiom other Station B3/B4 screens use
// (@invenpro/core's useDbQuery), scoped to just 'activity_log' since media isn't
// wired in here.

// ── Action icon map ───────────────────────────────────────────────────────────
// Exported so the logs screen (Station B4) and any other consumer can reuse
// without importing from a screen file — same "single source of truth" role
// this map had in the old app.
export const ACTION_ICONS: Record<string, string> = {
  // ---- existing equipment / stock actions ----
  checkout: '📦',
  checkout_to_job: '🚚',
  checkin: '↩',
  login: '👤',
  add_stock: '➕',
  add_units: '📥',
  transfer: '⇄',
  delete: '🗑',
  repair_out: '🔧',
  repair_in: '✅',
  consumed: '📉',

  // ---- job actions ----
  job_created: '📋',
  job_updated: '✏️',
  job_archived: '📂',

  // ---- location actions ----
  location_created: '📍',
  location_updated: '📝',
  location_archived: '🗄',
  location_restored: '♻️',

  // ---- user / role actions ----
  user_created: '🧑',
  user_updated: '📝',
  user_role_changed: '🎭',
  user_pin_reset: '🔑',
  user_permission_changed: '🔒',
  role_min_pin_changed: '🔐',

  // ---- team actions ----
  team_created: '👥',
  team_updated: '✏️',
  team_member_added: '➕',
  team_member_removed: '➖',

  // ---- equipment unit actions ----
  unit_edited: '🛠',
  unit_retired: '⛔',

  // ---- #248 equipment/item cleanliness ("filth") state ----
  unit_marked_clean: '🧼',
  unit_marked_dirty: '🧽',
  unit_auto_dirty: '🧽',

  // ---- item actions ----
  item_created: '🆕',
  item_marked_needs_cleaning: '🧽',
  item_marked_clean: '🧼',

  // ---- #199 preview-as-role sessions (#233 audit) ----
  preview_started: '🕶️',
  preview_ended: '🚪',

  // ---- #203 request-access funnel (#234 audit) ----
  access_requested: '🙋',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Human-readable label: underscores → spaces. */
export function actionLabel(action: string): string {
  return action.replace(/_/g, ' ');
}

/** Returns a short relative-time string for a UTC ISO timestamp. */
function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Component ────────────────────────────────────────────────────────────────

export interface ActivityFeedProps {
  entityType: string;
  entityId: string;
  limit?: number;
}

export default function ActivityFeed({ entityType, entityId, limit = 50 }: ActivityFeedProps) {
  const s = useThemedStyles(makeStyles);
  const rows = useDbQuery(
    () => getLogForEntity(entityType, entityId, limit),
    [entityType, entityId, limit],
    ['activity_log'],
  );

  return (
    <View style={s.list}>
      {rows.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>No activity yet</Text>
        </View>
      ) : rows.map(r => (
        <View key={r.id} style={s.row}>
          <Text style={s.icon}>{ACTION_ICONS[r.action] ?? '·'}</Text>
          <View style={s.middle}>
            <Text style={s.action}>{actionLabel(r.action)}</Text>
            {r.user_name ? (
              <Text style={s.user}>{r.user_name}</Text>
            ) : null}
            {r.quantity != null && r.unit ? (
              <Text style={s.qty}>{r.quantity} {r.unit}</Text>
            ) : null}
            {r.note ? <Text style={s.note}>{r.note}</Text> : null}
          </View>
          <Text style={s.date}>{relativeDate(r.created_at)}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (t: Theme) => StyleSheet.create({
  list: { padding: 12, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: t.colors.surface,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
  middle: { flex: 1 },
  action: {
    fontSize: 14,
    fontWeight: '600',
    color: t.colors.textPrimary,
    textTransform: 'capitalize',
  },
  user: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  qty: { fontSize: 12, color: t.colors.success, marginTop: 2 },
  note: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  date: { fontSize: 11, color: t.colors.textMuted, paddingTop: 2 },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 14, color: t.colors.textMuted },
});
