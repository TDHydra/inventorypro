import { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, Image, Modal, TouchableOpacity,
  ScrollView, Dimensions,
} from 'react-native';
import { getLogForEntity, LogEntry } from '../db/queries/log';
import { getPrimaryMedia, getMediaForEntity, MediaRecord } from '../db/queries/media';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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

  // ---- item actions ----
  item_created: '🆕',
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

  // Lightbox state: null = closed; MediaRecord[] = open showing those photos
  const [lightbox, setLightbox] = useState<MediaRecord[] | null>(null);

  // Build a per-entry primary-media map once when entries change instead of
  // calling getPrimaryMedia inside each row's render pass.
  const mediaByRow = useMemo(() => {
    const m: Record<string, MediaRecord> = {};
    for (const r of entries) {
      const p = getPrimaryMedia('activity_log', r.id);
      if (p) m[r.id] = p;
    }
    return m;
  }, [entries]);

  return (
    <View style={s.list}>
      {entries.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>No activity yet</Text>
        </View>
      ) : entries.map(r => {
        const photo = mediaByRow[r.id];
        return (
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
            {photo ? (
              <TouchableOpacity
                onPress={() => setLightbox(getMediaForEntity('activity_log', r.id))}
                style={s.thumbBtn}
              >
                <Image
                  source={{ uri: photo.thumbnail_url ?? photo.url }}
                  style={s.thumbImg}
                />
              </TouchableOpacity>
            ) : null}
          </View>
        );
      })}

      {/* Lightbox — full-screen, tap anywhere to close; horizontal pager for multi-photo moves */}
      <Modal visible={lightbox !== null} transparent animationType="fade">
        <TouchableOpacity style={s.lightbox} onPress={() => setLightbox(null)} activeOpacity={1}>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            style={{ width: SCREEN_WIDTH }}
            contentContainerStyle={s.lightboxScroll}
          >
            {(lightbox ?? []).map((m, i) => (
              <Image
                key={i}
                source={{ uri: m.url }}
                style={[s.lightboxImg, { width: SCREEN_WIDTH }]}
                resizeMode="contain"
              />
            ))}
          </ScrollView>
          <Text style={s.lightboxClose}>✕ Tap to close</Text>
        </TouchableOpacity>
      </Modal>
    </View>
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
  // Trailing thumbnail on rows that have a move photo
  thumbBtn: { marginLeft: 4, alignSelf: 'center' },
  thumbImg: { width: 36, height: 36, borderRadius: 6, backgroundColor: '#E2E8F0' },
  // Lightbox overlay (mirrors MediaGallery lightbox pattern)
  lightbox: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  lightboxScroll: { alignItems: 'center' },
  lightboxImg: { height: '80%' },
  lightboxClose: { color: '#fff', marginTop: 16, fontSize: 14 },
});
