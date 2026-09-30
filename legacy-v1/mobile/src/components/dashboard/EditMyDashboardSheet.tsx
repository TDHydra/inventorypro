import { useEffect, useState, useSyncExternalStore } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { ModalSheet } from '../ui/ModalSheet';
import { DragList } from '../ui/DragList';
import { WIDGET_REGISTRY, type Layout, type LayoutBlock, type WidgetType } from '../../dashboard/widgets';
import { filterTilesForUser } from '../../dashboard/presetFilter';
import { makeStarKey } from '../../dashboard/starKeys';
import {
  hasPermission,
  subscribeRolePermissions,
  getRolePermissionsVersion,
  type UserSession,
} from '../../auth/permissions';
import { setDashboardLayout, setStarredWidgets } from '../../db/userPrefs';
import { loadDashboardCache } from '../../dashboard/store';
import { isWriteBlocked } from '../../db/maintenance';
import { generateUUID } from '../../utils/uuid';

// Personal dashboard editor (#193 layout, #196 starred favorites). A single
// ModalSheet (kit rule: one visible Modal at a time) with two sections: the
// user's current blocks (reorder via DragList, star, hide) and an always-
// visible "Available widgets" list of permitted tiles not currently shown —
// no second sheet/modal for "add", just an inline section beneath. Every
// mutation persists immediately (setDashboardLayout/setStarredWidgets) and
// calls loadDashboardCache() to notify useDashboardLayout()/useStarredWidgets()
// subscribers, mirroring the "changes save automatically" idiom + explicit
// notify-subscribers call the admin dashboards.tsx/roles.tsx screens already
// use after their own preset/role writes.

type KeyedBlock = { key: string; block: LayoutBlock };

const ROW_HEIGHT = 56;

const TILE_WIDGETS = (Object.keys(WIDGET_REGISTRY) as WidgetType[]).filter(
  (w) => WIDGET_REGISTRY[w].kind === 'tile',
);

const hitSlop = { top: 6, bottom: 6, left: 4, right: 4 };

function blockLabel(block: LayoutBlock): string {
  const def = WIDGET_REGISTRY[block.widget];
  if (block.widget === 'section') return block.config?.sectionTitle?.trim() || 'Section';
  return block.config?.label?.trim() || def?.label || block.widget;
}

function blockIcon(block: LayoutBlock): string {
  const def = WIDGET_REGISTRY[block.widget];
  if (block.widget === 'section') return '▤';
  return block.config?.icon?.trim() || def?.icon || '▦';
}

export function EditMyDashboardSheet({
  visible,
  onClose,
  user,
  currentLayout,
  starred,
}: {
  visible: boolean;
  onClose: () => void;
  user: UserSession;
  // The presently-EFFECTIVE layout (personal ?? preset ?? role ?? default) —
  // the screen already resolves this via useDashboardLayout(user); passed down
  // rather than re-resolved here so the editor always starts from what the
  // user is actually looking at.
  currentLayout: Layout;
  starred: string[]; // #226: plain WidgetType or composite `widget:source` star keys
}) {
  const s = useThemedStyles(makeStyles);
  // Reactive permission cache (same subscription usePermission() makes) so the
  // "Available widgets" list updates live if an admin changes this user's
  // role permissions while the sheet happens to be open.
  useSyncExternalStore(subscribeRolePermissions, getRolePermissionsVersion, getRolePermissionsVersion);

  const [blocks, setBlocks] = useState<KeyedBlock[]>([]);
  const [starredSet, setStarredSet] = useState<Set<string>>(new Set());

  // Re-seed the working copy every time the sheet opens — a stale in-memory
  // draft from a previous open must not clobber a change that landed elsewhere
  // (another device's sync pull, an admin reassigning the role preset) meanwhile.
  useEffect(() => {
    if (!visible) return;
    setBlocks(currentLayout.map((block) => ({ key: generateUUID(), block })));
    setStarredSet(new Set(starred));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const present = new Set(blocks.map((b) => b.block.widget));
  const offeredTiles = filterTilesForUser(
    TILE_WIDGETS.filter((w) => !present.has(w)),
    (perm) => hasPermission(user, perm),
  );

  function persistLayout(next: KeyedBlock[]) {
    // Maintenance lock (house rule: every write affordance checks): silent
    // early-return, same as the admin editor's persist().
    if (isWriteBlocked()) return;
    setBlocks(next);
    setDashboardLayout(user.id, next.map((b) => b.block));
    loadDashboardCache();
  }

  function handleReorder(orderedKeys: string[]) {
    const byKey = new Map(blocks.map((b) => [b.key, b]));
    persistLayout(orderedKeys.map((k) => byKey.get(k)!).filter(Boolean));
  }

  function hideBlock(index: number) {
    persistLayout(blocks.filter((_, i) => i !== index));
  }

  function addWidget(widget: WidgetType) {
    persistLayout([...blocks, { key: generateUUID(), block: { widget, width: 'full' } }]);
  }

  function toggleStar(key: string) {
    if (isWriteBlocked()) return;
    const next = new Set(starredSet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setStarredSet(next);
    setStarredWidgets(user.id, [...next]);
    loadDashboardCache();
  }

  function resetToDefault() {
    Alert.alert(
      'Reset to default?',
      'Your personal layout changes will be cleared and the dashboard falls back to your assigned preset. Starred widgets are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            if (isWriteBlocked()) return;
            setDashboardLayout(user.id, null);
            loadDashboardCache();
            onClose();
          },
        },
      ],
    );
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <View style={s.content}>
        <Text style={s.title}>My Dashboard</Text>
        <Text style={s.sub}>Drag to reorder, star for your favorites strip, or hide. Changes save automatically.</Text>

        <View style={s.card}>
          {blocks.length === 0 ? (
            <Text style={s.emptyText}>Nothing on your dashboard yet — add a widget below.</Text>
          ) : (
            <DragList
              items={blocks}
              keyExtractor={(b) => b.key}
              rowHeight={ROW_HEIGHT}
              onReorder={handleReorder}
              renderRow={(item, api) => {
                const def = WIDGET_REGISTRY[item.block.widget];
                const isTile = def?.kind === 'tile';
                // #226: a configured work-list stars as `work-list:<source>`
                // so ONE list (e.g. My Jobs) can sit on the favorites strip.
                const workListSource = item.block.widget === 'work-list' ? item.block.config?.source : undefined;
                const starKey = makeStarKey(item.block.widget, workListSource);
                const starrable = isTile || !!workListSource;
                const starredOn = starredSet.has(starKey);
                return (
                  <View style={[s.row, api.index > 0 && s.rowBorder]}>
                    {/* Grab handle (best-effort PanResponder on web) — the
                        up/down arrows below are the always-present fallback,
                        same convention as the admin dashboards.tsx editor. */}
                    <View
                      {...api.panHandlers}
                      style={s.dragHandle}
                      accessibilityLabel={`Drag to reorder ${blockLabel(item.block)}`}
                    >
                      <Text style={s.dragGlyph}>≡</Text>
                    </View>
                    <Text style={s.rowIcon}>{blockIcon(item.block)}</Text>
                    <Text style={s.rowLabel} numberOfLines={1}>{blockLabel(item.block)}</Text>
                    {starrable && (
                      <TouchableOpacity
                        onPress={() => toggleStar(starKey)}
                        hitSlop={hitSlop}
                        style={s.iconBtn}
                        accessibilityLabel={starredOn ? `Unstar ${blockLabel(item.block)}` : `Star ${blockLabel(item.block)}`}
                      >
                        <Text style={[s.star, starredOn && s.starOn]}>{starredOn ? '★' : '☆'}</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={api.moveUp} disabled={api.isFirst} hitSlop={hitSlop} style={s.iconBtn}>
                      <Text style={[s.arrow, api.isFirst && s.arrowDisabled]}>▲</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={api.moveDown} disabled={api.isLast} hitSlop={hitSlop} style={s.iconBtn}>
                      <Text style={[s.arrow, api.isLast && s.arrowDisabled]}>▼</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => hideBlock(api.index)} hitSlop={hitSlop} style={s.iconBtn}>
                      <Text style={s.hideGlyph}>Hide</Text>
                    </TouchableOpacity>
                  </View>
                );
              }}
            />
          )}
        </View>

        {offeredTiles.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Available widgets</Text>
            <View style={s.pickGrid}>
              {offeredTiles.map((w) => (
                <TouchableOpacity key={w} style={s.pickItem} onPress={() => addWidget(w)}>
                  <Text style={s.pickIcon}>{WIDGET_REGISTRY[w].icon ?? '•'}</Text>
                  <Text style={s.pickLabel} numberOfLines={1}>{WIDGET_REGISTRY[w].label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        <TouchableOpacity style={s.resetRow} onPress={resetToDefault}>
          <Text style={s.resetText}>Reset to default</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.doneBtn} onPress={onClose}>
          <Text style={s.doneText}>Done</Text>
        </TouchableOpacity>
      </View>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { gap: 12 },
  title: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary },
  sub: { fontSize: 13, color: t.colors.textSecondary },
  card: { backgroundColor: t.colors.surfaceAlt, borderRadius: 12, overflow: 'hidden' },
  emptyText: { padding: 16, color: t.colors.textSecondary, fontSize: 13 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    height: ROW_HEIGHT,
    backgroundColor: t.colors.surface,
  },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.border },
  dragHandle: { width: 28, alignItems: 'center', justifyContent: 'center' },
  dragGlyph: { fontSize: 18, color: t.colors.textMuted },
  rowIcon: { fontSize: 16, width: 22, textAlign: 'center' },
  rowLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: t.colors.textPrimary },
  iconBtn: { paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  star: { fontSize: 18, color: t.colors.textMuted },
  starOn: { color: t.colors.accent },
  arrow: { fontSize: 13, color: t.colors.textSecondary },
  arrowDisabled: { color: t.colors.border },
  hideGlyph: { fontSize: 12, fontWeight: '700', color: t.colors.danger },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: t.colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  pickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickItem: {
    width: '30%',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  pickIcon: { fontSize: 18 },
  pickLabel: { fontSize: 11, color: t.colors.textPrimary, textAlign: 'center' },
  resetRow: { alignItems: 'center', paddingVertical: 8 },
  resetText: { fontSize: 13, fontWeight: '600', color: t.colors.textSecondary, textDecorationLine: 'underline' },
  doneBtn: {
    backgroundColor: t.colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  doneText: { color: t.colors.onPrimary, fontSize: 15, fontWeight: '700' },
});
