import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Alert } from '../../lib/themedAlert';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../db/maintenance';
import { useFocusOrDataRefresh } from '../../hooks/useFocusOrDataRefresh';
import { getLocationById, getLocationPath, getStockAtLocation } from '../../db/queries/locations';
import { getUserById, getAllActiveUsers } from '../../db/queries/users';
import {
  getLockerAccessList, grantLockerAccess, revokeLockerAccess, canManageLockerAccess,
} from '../../db/queries/access';
import { ROLE_DISPLAY_NAMES, UserRole } from '../../constants/roles';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AccessListEditor, AccessEntry } from '../crew/AccessListEditor';
import type { PickerOption } from '../SearchablePicker';

// LockerPanel (#126) — the embeddable "everything about this locker" block
// (component-first hard requirement of #122). Self-loads from locationId and
// re-reads on focus/sync-pull. Rendered three ways: full (LockerSheet / any
// future route), summary (embedded in (locations)/[id] above the stock list,
// where the host already shows name + stock), and always read-only for access
// unless canManageLockerAccess (owner or tier-3+ — the server guard's mirror).
// "Check out from here" emits the hub href with the `loc` scoping param; C4
// owns wiring that param on the hub side.

const CONTENTS_PREVIEW_ROWS = 5;

interface Props {
  locationId: string;
  variant?: 'full' | 'summary';
  /** When set, navigation intents are emitted as an href for the host (e.g. a
   *  sheet that must close first) instead of pushed directly. */
  onNavigate?: (href: string) => void;
}

export function LockerPanel({ locationId, variant = 'full', onNavigate }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const router = useRouter();

  // Re-read on focus / sync pull, plus a local bump after our own grant/revoke
  // writes (local writes don't tick dataVersion).
  const refreshKey = useFocusOrDataRefresh();
  const [localBump, setLocalBump] = useState(0);
  const key = refreshKey + localBump;

  const location = useMemo(() => getLocationById(locationId), [locationId, key]);
  const path = useMemo(() => getLocationPath(locationId), [locationId, key]);
  const owner = useMemo(
    () => (location?.owner_user_id ? getUserById(location.owner_user_id) : null),
    [location?.owner_user_id, key],
  );
  const stock = useMemo(() => getStockAtLocation(locationId), [locationId, key]);
  const accessList = useMemo(() => getLockerAccessList(locationId), [locationId, key]);

  const canManage = canManageLockerAccess(user, location);
  const [showAccessEditor, setShowAccessEditor] = useState(false);

  // Owner is an implicit, non-removable entry; explicit grants follow.
  const editorEntries = useMemo<AccessEntry[]>(() => {
    const entries: AccessEntry[] = [];
    if (owner) entries.push({ userId: owner.id, name: owner.name, sublabel: 'Owner', fixed: true });
    for (const g of accessList) {
      if (g.user_id === owner?.id) continue;
      entries.push({
        userId: g.user_id,
        name: g.user_name ?? g.user_id,
        sublabel: g.granted_by_name ? `Granted by ${g.granted_by_name}` : null,
      });
    }
    return entries;
  }, [owner, accessList]);

  const candidates = useMemo<PickerOption[]>(() => {
    if (!showAccessEditor) return [];
    const excluded = new Set(editorEntries.map(e => e.userId));
    return getAllActiveUsers()
      .filter(u => !excluded.has(u.id))
      .map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role as UserRole] ?? u.role }));
  }, [showAccessEditor, editorEntries, key]);

  function handleCheckoutFromHere() {
    const href = `/(app)/(hub)?loc=${locationId}`;
    if (onNavigate) { onNavigate(href); return; }
    router.push({ pathname: '/(app)/(hub)', params: { loc: locationId } });
  }

  // AccessListEditor owns the confirm/alert UX; these just do the writes and
  // refresh. Throwing keeps the editor open with an alert.
  function handleGrant(opt: PickerOption) {
    if (isWriteBlocked()) throw new Error('write blocked');
    grantLockerAccess(locationId, opt.id, user?.id ?? null);
    setLocalBump(b => b + 1);
  }
  function handleRevoke(entry: AccessEntry) {
    if (isWriteBlocked()) throw new Error('write blocked');
    revokeLockerAccess(locationId, entry.userId, user?.id ?? null);
    setLocalBump(b => b + 1);
  }

  if (!location) {
    return variant === 'full'
      ? <EmptyState icon="🔒" title="Locker not found" subtitle="It may have been removed on another device." />
      : null;
  }

  const totalQty = stock.reduce((sum, r) => sum + r.quantity, 0);
  const preview = stock.slice(0, CONTENTS_PREVIEW_ROWS);

  return (
    <Card variant="detail">
      {/* Header — the summary embed's host screen already titles itself with
          the location name, so only the full variant repeats it. */}
      {variant === 'full' && (
        <>
          <Text style={s.name}>{location.name}</Text>
          {path !== location.name && <Text style={s.path}>{path}</Text>}
        </>
      )}
      <View style={s.ownerRow}>
        <Text style={s.ownerLabel}>Owner</Text>
        <Text style={s.ownerName}>{owner ? owner.name : 'No owner'}</Text>
      </View>

      {/* Contents summary (full only — the summary embed sits above the host's own stock list). */}
      {variant === 'full' && (
        <View style={s.section}>
          <Text style={s.sectionLabel}>
            Contents · {stock.length} item{stock.length === 1 ? '' : 's'}{stock.length > 0 ? ` · ${totalQty} total` : ''}
          </Text>
          {stock.length === 0 ? (
            <Text style={s.muted}>Nothing stored here right now.</Text>
          ) : (
            <>
              {preview.map(row => (
                <View key={row.item_id} style={s.stockRow}>
                  <Text style={s.stockName} numberOfLines={1}>{row.name}</Text>
                  <Text style={s.stockQty}>{row.quantity}</Text>
                </View>
              ))}
              {stock.length > preview.length && (
                <Text style={s.moreText}>+{stock.length - preview.length} more</Text>
              )}
            </>
          )}
        </View>
      )}

      <PrimaryButton
        label="Check out from here"
        onPress={handleCheckoutFromHere}
        style={s.checkoutBtn}
      />

      {/* Access chips (read-only at a glance) + Manage for owner / org authority. */}
      <View style={s.section}>
        <View style={s.accessHeader}>
          <Text style={s.sectionLabel}>Access</Text>
          {canManage && (
            <TouchableOpacity
              onPress={() => {
                if (locked) { Alert.alert('Maintenance mode', 'Access changes are paused during maintenance.'); return; }
                setShowAccessEditor(true);
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={s.manageLink}>Manage access</Text>
            </TouchableOpacity>
          )}
        </View>
        <View style={s.chips}>
          {editorEntries.length === 0 ? (
            <Text style={s.muted}>Owner only.</Text>
          ) : (
            editorEntries.map(e => (
              <View key={e.userId} style={[s.chip, e.fixed && s.chipOwner]}>
                <Text style={[s.chipText, e.fixed && s.chipOwnerText]}>
                  {e.fixed ? `★ ${e.name}` : e.name}
                </Text>
              </View>
            ))
          )}
        </View>
        {owner && (
          <Text style={s.teamNote}>Teammates of {owner.name} can also check out from here.</Text>
        )}
      </View>

      <AccessListEditor
        visible={showAccessEditor}
        onClose={() => setShowAccessEditor(false)}
        title={`${location.name} · Access`}
        entries={editorEntries}
        candidates={candidates}
        canEdit={canManage && !locked}
        onAdd={handleGrant}
        onRemove={handleRevoke}
        removeNoun="access to this locker"
      />
    </Card>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  name: { fontSize: 20, fontWeight: '700', color: t.colors.brand },
  path: { fontSize: 12, color: t.colors.textMuted, marginTop: 2 },
  muted: { fontSize: 13, color: t.colors.textMuted },

  ownerRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: t.spacing.sm,
  },
  ownerLabel: { fontSize: 14, color: t.colors.textSecondary },
  ownerName: { fontSize: 14, color: t.colors.textPrimary, fontWeight: '600' },

  section: { marginTop: t.spacing.base },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: t.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6,
  },

  stockRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  stockName: { fontSize: 14, color: t.colors.textPrimary, flex: 1, marginRight: 12 },
  stockQty: { fontSize: 14, color: t.colors.textSecondary, fontWeight: '600' },
  moreText: { fontSize: 12, color: t.colors.textMuted, marginTop: 4 },

  checkoutBtn: { marginTop: t.spacing.base },

  accessHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  manageLink: { color: t.colors.primary, fontSize: 13, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    borderWidth: 1, borderColor: t.colors.border, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  chipText: { fontSize: 13, color: t.colors.textSecondary, fontWeight: '600' },
  chipOwner: { backgroundColor: t.colors.primaryBg, borderColor: t.colors.primaryBg },
  chipOwnerText: { color: t.colors.primaryText },
  teamNote: { fontSize: 12, color: t.colors.textMuted, marginTop: 8, lineHeight: 16 },
});
