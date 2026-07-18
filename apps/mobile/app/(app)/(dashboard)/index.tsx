import { ScrollView, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { PermissionGate } from '../../../src/components/PermissionGate';
import { QuickAddBanner } from '../../../src/components/QuickAddBanner';
import { DashboardSearch } from '../../../src/components/DashboardSearch';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { getLowStockItems } from '../../../src/db/queries/items';
import { roleColor } from '../../../src/db/queries/users';
import { useMemo, useState, type ReactNode } from 'react';
import { ROLE_DISPLAY_NAMES, type Permission } from '../../../src/constants/roles';
import { track } from '../../../src/telemetry';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { useDashboardLayout } from '../../../src/dashboard/store';
import { useTotalUnread } from '../../../src/chat/store';
import { WIDGET_REGISTRY, type LayoutBlock, type WidgetType } from '../../../src/dashboard/widgets';
import { useDataVersion } from '../../../src/hooks/useDataVersion';

function timeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// hub_* telemetry action per widget — preserves today's exact track() calls (only
// these three tiles were instrumented). Non-listed tiles fire no telemetry, as now.
const HUB_TRACK: Partial<Record<WidgetType, string>> = {
  checkout: 'hub_checkout',
  checkin: 'hub_checkin',
  'my-checkouts': 'hub_active_checkouts',
};

export default function DashboardScreen() {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const router = useRouter();
  const [reshow, setReshow] = useState<(() => void) | null>(null);
  // Keyed on dataVersion so the low-stock widget updates live after a sync pull
  // (the layout is already reactive via useDashboardLayout; the DATA wasn't) (#61).
  const dataVersion = useDataVersion();
  const all = useMemo(() => getLowStockItems(), [dataVersion]);
  const shown = all.slice(0, 3);

  // Resolved per-user/role layout. An unassigned user resolves to DEFAULT_LAYOUT,
  // which reproduces today's dashboard exactly (same tiles/order/gates below).
  const layout = useDashboardLayout(user);
  // Unread badge on the Messages tile — reactive via the chat store (loadChatCache
  // runs at boot, post-pull, and from the chat screens' own writes).
  const chatUnread = useTotalUnread();

  if (!user) return null;

  // The greeting + tooltip are fixed chrome (not layout widgets). Today they sit
  // directly after the pinned search, so we inject them right after the `search`
  // block to keep the default order byte-for-byte. If a custom preset omits search,
  // they render at the very top instead so the user is never greeting-less.
  const greeting = (
    <View key="__greeting">
      <View style={s.greeting}>
        <View style={s.greetingText}>
          <Text style={[s.hi, { color: roleColor(user.role) }]}>{timeGreeting()}, {user.name.split(' ')[0]}</Text>
          <Text style={s.role}>{ROLE_DISPLAY_NAMES[user.role]}</Text>
        </View>
        <TouchableOpacity onPress={() => reshow?.()} style={s.questionBtn}>
          <Text style={s.questionBtnText}>?</Text>
        </TouchableOpacity>
      </View>
      <TooltipHint screenKey="dashboard" onReady={fn => setReshow(() => fn)} />
    </View>
  );

  // A single tile block → the same TouchableOpacity styling/onPress as today, wrapped
  // in its PermissionGate so a preset can NEVER surface an unauthorized tile.
  const renderTile = (block: LayoutBlock, key: string): ReactNode => {
    const def = WIDGET_REGISTRY[block.widget];
    if (!def || def.kind !== 'tile') return null;
    const label = block.config?.label ?? def.label;
    const icon = block.config?.icon ?? def.icon;
    const route = def.route;
    const primary = block.widget === 'checkout';
    const trackKey = HUB_TRACK[block.widget];

    const onPress = () => {
      if (trackKey) track('action', trackKey, { screen: 'hub' });
      if (route) router.push(route as never);
    };

    const tile = (
      <TouchableOpacity
        style={[
          s.tile,
          primary && s.tilePrimary,
          block.width === 'half' && s.tileHalf,
        ]}
        onPress={onPress}
      >
        <Text style={s.tileIcon}>{icon}</Text>
        <Text style={primary ? s.tileLabelPrimary : s.tileLabel}>{label}</Text>
        {primary && <Text style={s.tileSubPrimary}>Scan or search for an item</Text>}
        {block.widget === 'chat' && chatUnread > 0 && (
          <View style={s.tileBadge}>
            <Text style={s.tileBadgeText}>{chatUnread > 99 ? '99+' : chatUnread}</Text>
          </View>
        )}
      </TouchableOpacity>
    );

    // requiredPermission is always present for tile widgets; gate on it.
    return def.requiredPermission ? (
      <PermissionGate key={key} permission={def.requiredPermission}>{tile}</PermissionGate>
    ) : (
      <View key={key}>{tile}</View>
    );
  };

  // The permission that gates a section header: the requiredPermission of the first
  // TILE that follows the section (until the next section / end). This reproduces
  // today's per-section PermissionGate exactly — Inventory→add_inventory (add-stock),
  // Operations→create_jobs (jobs), Admin→manage_users (users) — so a user who can't
  // see any tile in a section never sees a bare header, just like now.
  const sectionGate = (sectionIndex: number): Permission | undefined => {
    for (let j = sectionIndex + 1; j < layout.length; j++) {
      const w = layout[j].widget;
      if (w === 'section') break;
      const d = WIDGET_REGISTRY[w];
      if (d?.kind === 'tile') return d.requiredPermission;
    }
    return undefined;
  };

  // A block widget (search / quick-add / low-stock / section header) → its existing
  // component/list, reusing today's s. `gatePerm` (section only) wraps the
  // header so it hides when the user can't see any tile beneath it.
  const renderBlock = (block: LayoutBlock, key: string, gatePerm?: Permission): ReactNode => {
    switch (block.widget) {
      case 'search':
        return <DashboardSearch key={key} />;
      case 'quick-add':
        return <QuickAddBanner key={key} />;
      case 'section': {
        if (!block.config?.sectionTitle) return null;
        const header = <Text style={s.sectionTitle}>{block.config.sectionTitle}</Text>;
        return gatePerm
          ? <PermissionGate key={key} permission={gatePerm}>{header}</PermissionGate>
          : <View key={key}>{header}</View>;
      }
      case 'low-stock':
        return shown.length > 0 ? (
          <View key={key} style={s.alert}>
            <Text style={s.alertTitle}>⚠️ Low Stock</Text>
            {shown.map(item => (
              <TouchableOpacity
                key={item.id}
                onPress={() =>
                  router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: item.id } })
                }
              >
                <Text style={s.alertItem}>
                  {item.name} — {item.total_stock} {item.unit} remaining
                </Text>
              </TouchableOpacity>
            ))}
            {all.length > 3 && <Text style={s.alertMore}>+{all.length - 3} more</Text>}
          </View>
        ) : null;
      default:
        // A tile widget reached the block dispatcher (shouldn't happen).
        return renderTile(block, key);
    }
  };

  const isTile = (w: WidgetType) => WIDGET_REGISTRY[w]?.kind === 'tile';

  // Walk the layout into a flat element list. Consecutive half-width tiles are
  // paired into a responsive row; everything else is full-width and stacked. The
  // greeting chrome is injected right after the search block (or at the top if the
  // layout has no search block).
  const hasSearch = layout.some(b => b.widget === 'search');
  const elements: ReactNode[] = [];
  if (!hasSearch) elements.push(greeting);

  for (let i = 0; i < layout.length; i++) {
    const block = layout[i];
    const next = layout[i + 1];
    // Pair two adjacent half tiles side by side.
    if (block.width === 'half' && isTile(block.widget) && next?.width === 'half' && isTile(next.widget)) {
      elements.push(
        <View key={`row-${i}`} style={s.row}>
          {renderTile(block, `b-${i}`)}
          {renderTile(next, `b-${i + 1}`)}
        </View>,
      );
      i++;
    } else if (isTile(block.widget)) {
      elements.push(renderTile(block, `b-${i}`));
    } else if (block.widget === 'section') {
      elements.push(renderBlock(block, `b-${i}`, sectionGate(i)));
    } else {
      elements.push(renderBlock(block, `b-${i}`));
    }
    if (block.widget === 'search') elements.push(greeting);
  }

  return (
    <>
      <Stack.Screen options={{ title: 'InventoryPro', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        {elements}
      </ScrollView>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  greeting: { marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  greetingText: { flex: 1 },
  hi: { fontSize: 24, fontWeight: '700', color: t.colors.brand },
  role: { fontSize: 13, color: t.colors.textSecondary, textTransform: 'capitalize' },
  questionBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: t.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  questionBtnText: { fontSize: 14, fontWeight: '700', color: t.colors.textSecondary },
  tile: {
    backgroundColor: t.colors.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  tilePrimary: {
    backgroundColor: t.colors.primary,
    borderColor: t.colors.primary,
    paddingVertical: 20,
  },
  tileHalf: { flex: 1 },
  tileBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tileBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  tileIcon: { fontSize: 22, marginBottom: 6 },
  tileLabel: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  tileLabelPrimary: { fontSize: 18, fontWeight: '700', color: t.colors.onPrimary, marginBottom: 4 },
  tileSubPrimary: { fontSize: 13, color: t.colors.primaryBg },
  row: { flexDirection: 'row', gap: 10 },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: t.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 8,
  },
  alert: {
    backgroundColor: t.colors.accentBg,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: t.colors.border,
    gap: 4,
  },
  alertTitle: { fontSize: 14, fontWeight: '700', color: t.colors.accent },
  alertItem: { fontSize: 13, color: t.colors.accent },
  alertMore: { fontSize: 13, color: t.colors.accent, fontWeight: '600', marginTop: 2 },
});
