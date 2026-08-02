import { useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useTableVersion } from '../../hooks/useDataVersion';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { ACTION_ICONS, actionLabel } from '../ActivityFeed';
import { getRecentLog } from '../../db/queries/log';
import { track } from '../../telemetry';
import type { WidgetConfig } from '../../dashboard/widgets';

// ActivityPreview (role dashboards §2): the last N activity-log entries as a
// compact card, tapping through to the full Activity Logs screen. Reuses the
// ActivityFeed action icon/label helpers + db/queries/log. The block renderer
// wraps this in <PermissionGate permission="view_all_logs"> (the registry's
// requiredPermission), so it honors the same gate as the logs tile.

const DEFAULT_LIMIT = 5;

/** Short relative-time for a UTC ISO timestamp (mirrors ActivityFeed's). */
function relativeDate(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
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

interface Props { config?: WidgetConfig }

export function ActivityPreview({ config }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const limit = typeof config?.limit === 'number' && config.limit > 0 ? config.limit : DEFAULT_LIMIT;
  // Re-read when a pull (or local write) touches the log, like ActivityFeed.
  // users: getRecentLog joins it for user_name, so a rename refreshes too.
  const v = useTableVersion(['activity_log', 'users']);
  // #195: a THROWING read must not look like "no activity" — erroredRef is
  // set synchronously inside this useMemo (re-evaluated on every limit/version
  // change, same lifecycle as `entries`), so render below always reflects the
  // outcome of the read that produced the current `entries`.
  const erroredRef = useRef(false);
  const entries = useMemo(() => {
    try {
      const rows = getRecentLog(limit);
      erroredRef.current = false;
      return rows;
    } catch {
      erroredRef.current = true;
      track('error', 'activity_preview_read_failed', { screen: 'dashboard' });
      return [];
    }
  }, [limit, v]);

  const title = config?.title?.trim() || 'Recent Activity';

  if (entries.length === 0) {
    // #195: a throwing query must stay visible with an error presentation —
    // collapsing it identically to "nothing to show" hid real failures from
    // the office. Genuine empty (erroredRef false, generalizes #144) still
    // collapses the whole card instead of showing "No activity yet".
    if (erroredRef.current) {
      return (
        <Card>
          <EmptyState icon="⚠️" title={`Couldn't load ${title}`} subtitle="Pull to sync, or check back shortly." />
        </Card>
      );
    }
    return null;
  }

  return (
    <Card>
      <Text style={s.title}>📊 {title}</Text>
      <View style={s.rows}>
        {entries.map(r => (
          <View key={r.id} style={s.row}>
            <Text style={s.icon}>{ACTION_ICONS[r.action] ?? '·'}</Text>
            <View style={s.middle}>
              <Text style={s.action} numberOfLines={1}>{actionLabel(r.action)}</Text>
              {r.user_name ? <Text style={s.user} numberOfLines={1}>{r.user_name}</Text> : null}
            </View>
            <Text style={s.date}>{relativeDate(r.created_at)}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity style={s.viewAll} onPress={() => router.push('/(app)/(logs)' as never)}>
        <Text style={s.viewAllText}>View all ›</Text>
      </TouchableOpacity>
    </Card>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.sm },
  rows: { gap: t.spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  icon: { fontSize: t.typography.fontSizes.base, width: 24, textAlign: 'center' },
  middle: { flex: 1 },
  action: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.textPrimary, textTransform: 'capitalize' },
  user: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary },
  date: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted },
  viewAll: { marginTop: t.spacing.sm, alignSelf: 'flex-start' },
  viewAllText: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.primary },
});
