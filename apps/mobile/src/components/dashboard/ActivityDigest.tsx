import { useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useTableVersion } from '../../hooks/useDataVersion';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { ACTION_ICONS, actionLabel } from '../ActivityFeed';
import { getLogFiltered } from '../../db/queries/log';
import { tallyActions } from '../../dashboard/activityDigest';
import { track } from '../../telemetry';
import type { WidgetConfig } from '../../dashboard/widgets';

// ActivityDigest (#227): the week's activity as action-type counts — the
// trend view next to ActivityPreview's last-5 ticker. Same view_all_logs gate
// (the block renderer wraps it in the registry's PermissionGate) and the same
// #195 error-vs-empty presentation.

const WINDOW_DAYS = 7;
// getLogFiltered's default cap (200) would undercount a busy week; one week of
// this team's activity fits comfortably under this.
const READ_LIMIT = 2000;

export function ActivityDigest({ config }: { config?: WidgetConfig }) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const v = useTableVersion(['activity_log']);
  const erroredRef = useRef(false);
  const tallies = useMemo(() => {
    try {
      const sinceISO = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const out = tallyActions(getLogFiltered({ sinceISO }, READ_LIMIT));
      erroredRef.current = false;
      return out;
    } catch {
      erroredRef.current = true;
      track('error', 'activity_digest_read_failed', { screen: 'dashboard' });
      return [];
    }
  }, [v]);

  const title = config?.title?.trim() || 'This Week';

  if (tallies.length === 0) {
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
      <Text style={s.title}>📈 {title}</Text>
      <View style={s.rows}>
        {tallies.map(r => (
          <View key={r.action} style={s.row}>
            <Text style={s.icon}>{ACTION_ICONS[r.action] ?? '·'}</Text>
            <Text style={s.action} numberOfLines={1}>{actionLabel(r.action)}</Text>
            <Text style={s.count}>{r.count}</Text>
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
  action: { flex: 1, fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.textPrimary, textTransform: 'capitalize' },
  count: { fontSize: t.typography.fontSizes.body2, fontWeight: '700', color: t.colors.textSecondary },
  viewAll: { marginTop: t.spacing.sm, alignSelf: 'flex-start' },
  viewAllText: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.primary },
});
