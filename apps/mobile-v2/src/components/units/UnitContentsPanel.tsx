// UnitContentsPanel (#122 A2 Task 4) — contents list + actions for a unit
// (Vehicle/Locker), gated per-action by resolveUnitActionPerms over the
// unit_access row (getUserUnitPerms). Action mapping:
//   view   → the contents list itself (no view → render nothing)
//   add    → "+ Add Stock Here" → quickadd stock sheet with locationId prefilled
//   remove → "Check out from here" → /(app)/checkout?loc=  (checkout is how stock leaves a unit)
//   move   → "Move Stock" → MoveStockModal
//
// Ported from apps/mobile/src/components/units/UnitContentsPanel.tsx in
// Station D3 (was TODO(wave-D) in Vehicle/LockerPanel). Import mapping per
// docs/REBUILD-PORTING.md; route mapping: old (inventory)/add →
// quickadd/[sheet] (sheet: 'stock'), old (hub)?loc= → checkout?loc=.
import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { PrimaryButton, useThemedStyles, type Theme } from '@invenpro/ui';
import { getLocationById, getStockAtLocation } from '../../repos/locations';
import { getUserUnitPerms, resolveUnitActionPerms } from '../../repos/access';
import { sharesTeamWithOwner } from '../../repos/ownership';
import { ROLE_TIER } from '../../constants/roles';
import { useSession } from '../../hooks/useSession';
import { useFocusOrDataRefresh } from '../../hooks/useFocusOrDataRefresh';
import MoveStockModal from '../MoveStockModal';

const PREVIEW_ROWS = 8;

interface Props { locationId: string; onNavigate?: (href: string) => void; }

export function UnitContentsPanel({ locationId, onNavigate }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const refreshKey = useFocusOrDataRefresh();

  const location = useMemo(() => getLocationById(locationId), [locationId, refreshKey]);
  const stock = useMemo(() => getStockAtLocation(locationId), [locationId, refreshKey]);
  const perms = useMemo(() => {
    if (!user || !location) return null;
    return resolveUnitActionPerms({
      isOwner: location.owner_user_id != null && location.owner_user_id === user.id,
      roleTier: ROLE_TIER[user.role] ?? 0,
      isTeammateOfOwner: sharesTeamWithOwner(user.id, location.owner_user_id ?? null),
      rowPerms: getUserUnitPerms(user.id, locationId),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, location?.owner_user_id, locationId, refreshKey]);

  const [showMove, setShowMove] = useState(false);
  if (!location || !perms || !perms.view) return null;

  function go(pathname: string, params: Record<string, string>) {
    if (onNavigate) { onNavigate(`${pathname}?${new URLSearchParams(params)}`); return; }
    router.push({ pathname, params } as never);
  }
  const totalQty = stock.reduce((sum, r) => sum + r.quantity, 0);
  const preview = stock.slice(0, PREVIEW_ROWS);

  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>
        Contents · {stock.length} item{stock.length === 1 ? '' : 's'}{stock.length > 0 ? ` · ${totalQty} total` : ''}
      </Text>
      {stock.length === 0 ? <Text style={s.muted}>Nothing stored here right now.</Text> : (
        <>
          {preview.map(row => (
            <View key={row.item_id} style={s.stockRow}>
              <Text style={s.stockName} numberOfLines={1}>{row.name}</Text>
              <Text style={s.stockQty}>{row.quantity}</Text>
            </View>
          ))}
          {stock.length > preview.length && <Text style={s.muted}>+{stock.length - preview.length} more</Text>}
        </>
      )}
      {perms.remove && (
        <PrimaryButton label="Check out from here" style={s.btn}
          onPress={() => go('/(app)/checkout', { loc: locationId })} />
      )}
      <View style={s.actionRow}>
        {perms.add && (
          <TouchableOpacity onPress={() => go('/(app)/quickadd/[sheet]', { sheet: 'stock', locationId })}>
            <Text style={s.link}>+ Add Stock Here</Text>
          </TouchableOpacity>
        )}
        {perms.move && stock.length > 0 && (
          <TouchableOpacity onPress={() => setShowMove(true)}>
            <Text style={s.link}>Move Stock</Text>
          </TouchableOpacity>
        )}
      </View>
      <MoveStockModal
        visible={showMove}
        fromLocationId={locationId}
        fromLocationName={location.name}
        onClose={() => setShowMove(false)}
        onDone={() => setShowMove(false)}
      />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  section: { marginTop: t.spacing.base },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  muted: { fontSize: 13, color: t.colors.textMuted },
  stockRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  stockName: { fontSize: 14, color: t.colors.textPrimary, flex: 1, marginRight: 12 },
  stockQty: { fontSize: 14, color: t.colors.textSecondary, fontWeight: '600' },
  btn: { marginTop: t.spacing.base },
  actionRow: { flexDirection: 'row', gap: 16, marginTop: t.spacing.sm },
  link: { color: t.colors.primary, fontSize: 13, fontWeight: '700' },
});
