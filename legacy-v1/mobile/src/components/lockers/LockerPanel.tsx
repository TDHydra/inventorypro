import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../db/maintenance';
import { useFocusOrDataRefresh } from '../../hooks/useFocusOrDataRefresh';
import { getLocationById, getLocationPath } from '../../db/queries/locations';
import { getUserById, getAllActiveUsers } from '../../db/queries/users';
import { canManageLockerAccess } from '../../db/queries/access';
import {
  getUnitAccessRows, getUserUnitPerms, revokeUnitAccess,
} from '../../db/queries/unitAccess';
import { grantUnitAccessWithDefaults } from '../../access/unitGrants';
import { ROLE_DISPLAY_NAMES, UserRole } from '../../constants/roles';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { AccessListEditor, AccessEntry } from '../crew/AccessListEditor';
import { UnitContentsPanel } from '../units/UnitContentsPanel';
import type { PickerOption } from '../SearchablePicker';

// LockerPanel (#126) — the embeddable "everything about this locker" block
// (component-first hard requirement of #122). Self-loads from locationId and
// re-reads on focus/sync-pull. Rendered three ways: full (LockerSheet / any
// future route), summary (embedded in (locations)/[id] above the stock list,
// where the host already shows name + stock), and always read-only for access
// unless the user can manage (owner or tier-3+ via canManageLockerAccess, or
// an explicit unit_access can_grant bit). Contents + checkout/add/move actions
// live in UnitContentsPanel (A2 Task 4), gated per-action by unit_access.

interface Props {
  locationId: string;
  variant?: 'full' | 'summary';
  /** When set, navigation intents are emitted as an href for the host (e.g. a
   *  sheet that must close first) instead of pushed directly. */
  onNavigate?: (href: string) => void;
}

export function LockerPanel({ locationId, variant = 'full', onNavigate }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  // Re-read on focus / sync pull — local writes (including our own grant/
  // revoke below) tick the data-version bus too, so one key covers both.
  const refreshKey = useFocusOrDataRefresh();

  const location = useMemo(() => getLocationById(locationId), [locationId, refreshKey]);
  const path = useMemo(() => getLocationPath(locationId), [locationId, refreshKey]);
  const owner = useMemo(
    () => (location?.owner_user_id ? getUserById(location.owner_user_id) : null),
    [location?.owner_user_id, refreshKey],
  );
  // A1's migration copied locker_access → unit_access, and the seeded-row
  // watermark gotcha applies: backfilled rows written at deploy time reach
  // already-enrolled devices via full download / A1's touched updated_at —
  // nothing to do here, just don't "fix" missing rows by re-granting blindly.
  const accessList = useMemo(() => getUnitAccessRows(locationId), [locationId, refreshKey]);

  // Owner / tier-3+ manage as before; the explicit per-unit can_grant bit also
  // opens the editor (per-action unit perms, A2 Task 4).
  const canManage = canManageLockerAccess(user, location)
    || (user ? getUserUnitPerms(user.id, locationId).grant : false);
  const [showAccessEditor, setShowAccessEditor] = useState(false);

  // Owner is an implicit, non-removable entry; explicit grants follow.
  const editorEntries = useMemo<AccessEntry[]>(() => {
    const entries: AccessEntry[] = [];
    if (owner) entries.push({ userId: owner.id, name: owner.name, sublabel: 'Owner', fixed: true });
    for (const g of accessList) {
      if (g.user_id === owner?.id) continue;
      const grantedByName = g.granted_by ? getUserById(g.granted_by)?.name : null;
      entries.push({
        userId: g.user_id,
        name: g.user_name ?? getUserById(g.user_id)?.name ?? g.user_id,
        sublabel: grantedByName ? `Granted by ${grantedByName}` : null,
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
  }, [showAccessEditor, editorEntries, refreshKey]);

  // AccessListEditor owns the confirm/alert UX; these just do the writes and
  // refresh. Throwing keeps the editor open with an alert. Grant CREATION
  // applies the admin's per-role unit_access_defaults template (#122 Phase B);
  // per-action edits live in the Teams-tab Member Permissions sheet.
  function handleGrant(opt: PickerOption) {
    if (isWriteBlocked()) throw new Error('write blocked');
    grantUnitAccessWithDefaults(locationId, opt.id, getUserById(opt.id)?.role ?? '', realUser?.id ?? null);
  }
  function handleRevoke(entry: AccessEntry) {
    if (isWriteBlocked()) throw new Error('write blocked');
    revokeUnitAccess(locationId, entry.userId);
  }

  if (!location) {
    return variant === 'full'
      ? <EmptyState icon="🔒" title="Locker not found" subtitle="It may have been removed on another device." />
      : null;
  }

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

      {/* Contents + per-action actions (full only — the summary embed sits
          above the host's own stock list, which already shows stock). */}
      {variant === 'full' && <UnitContentsPanel locationId={locationId} onNavigate={onNavigate} />}

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
