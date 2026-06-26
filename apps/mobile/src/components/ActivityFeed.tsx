import { useMemo } from 'react';
import { View, Text, FlatList, StyleSheet } from 'react-native';
import { getLogForEntity, LogEntry } from '../db/queries/log';

// ── Action icon map ───────────────────────────────────────────────────────────
// Exported so W6 (logs screen) and any other consumer can reuse without
// importing from the screen file.
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
  const entries = useMemo(
    () => getLogForEntity(entityType, entityId, limit),
    [entityType, entityId, limit],
  );

  return (
    <FlatList<LogEntry>
      data={entries}
      keyExtractor={item => item.id}
      contentContainerStyle={s.list}
      renderItem={({ item }) => (
        <View style={s.row}>
          <Text style={s.icon}>{ACTION_ICONS[item.action] ?? '·'}</Text>
          <View style={s.middle}>
            <Text style={s.action}>{actionLabel(item.action)}</Text>
            {item.user_name ? (
              <Text style={s.user}>{item.user_name}</Text>
            ) : null}
            {item.quantity != null && item.unit ? (
              <Text style={s.qty}>{item.quantity} {item.unit}</Text>
            ) : null}
            {item.note ? <Text style={s.note}>{item.note}</Text> : null}
          </View>
          <Text style={s.date}>{relativeDate(item.created_at)}</Text>
        </View>
      )}
      ListEmptyComponent={
        <View style={s.empty}>
          <Text style={s.emptyText}>No activity yet</Text>
        </View>
      }
    />
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  list: { padding: 12, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
  middle: { flex: 1 },
  action: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1E293B',
    textTransform: 'capitalize',
  },
  user: { fontSize: 12, color: '#64748B', marginTop: 2 },
  qty: { fontSize: 12, color: '#16A34A', marginTop: 2 },
  note: { fontSize: 12, color: '#64748B', marginTop: 2 },
  date: { fontSize: 11, color: '#94A3B8', paddingTop: 2 },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 14, color: '#94A3B8' },
});
