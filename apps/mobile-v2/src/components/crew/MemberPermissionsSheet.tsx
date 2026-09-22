// Ported from apps/mobile/src/components/crew/MemberPermissionsSheet.tsx.
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../db/queries/teams' → '../../repos/teams' (setMemberPermissionOverridesOnline,
//     TEAM_OVERRIDABLE_PERMISSIONS, TEAM_PERMISSION_LABELS, TeamMember)
//   '../../db/queries/log' (appendLog) → '../../db/queries/log' (unchanged path)
//   '../../auth/permissions', '../../constants/roles' → unchanged (already at these
//     paths in mobile-v2)
//   ui/* + useTheme/useThemedStyles/useSession/usePermission/useMaintenanceMode/
//     isWriteBlocked/confirmSheet → '@invenpro/ui' / '../../hooks/*' / '../../db/maintenance'
//   '../SearchablePicker' → '../SearchablePicker' (unchanged path)
//   '../../hooks/useDataVersion' (useTableVersion) → '@invenpro/core'
//
// Cut for this station (see docs/REBUILD-NOTES.md Wave B section):
//   - Per-unit access grants section (depends on the unported
//     src/db/queries/access.ts / src/db/queries/unitAccess.ts / src/access/unitGrants.ts
//     domain — TODO(gap), same class as locations.ts's unported vehicle helpers).
//   - Personal locker toggle (depends on the unported src/access/personalLocker.ts
//     domain — TODO(gap)).
// Only the team-permission-overrides section (the part that was originally inline
// on (teams)/[id].tsx before #122 Phase B) is ported this wave.
import { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import type { Theme } from '@invenpro/ui';
import {
  Alert, useTheme, useThemedStyles, ModalSheet, PrimaryButton, MaintenanceBanner,
} from '@invenpro/ui';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../db/maintenance';
import {
  setMemberPermissionOverridesOnline, TEAM_OVERRIDABLE_PERMISSIONS, TEAM_PERMISSION_LABELS,
  type TeamMember,
} from '../../repos/teams';
import { parsePermissionOverrides, roleHasPermission } from '../../auth/permissions';
import { canActOnTarget } from '../../constants/roles';
import type { Permission, UserRole } from '../../constants/roles';
import { appendLog } from '../../db/queries/log';

// Team permission overrides for one member (subset of #122 Phase B — see the
// TODO(gap) cuts above). One sheet per team member: toggles apply only within
// this team, drafted locally and saved as one PATCH (gated, online-only — the
// same online-only shape as promote/demote manager).
export function MemberPermissionsSheet(props: {
  visible: boolean;
  onClose: () => void;
  teamId: string;
  teamName: string;
  member: TeamMember | null;
  /** bump the host screen's local version after any write */
  onChanged: () => void;
}) {
  const { visible, onClose, teamId, teamName, member, onChanged } = props;
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  const [permDraft, setPermDraft] = useState<Record<string, boolean>>({});
  const [savingPerms, setSavingPerms] = useState(false);

  // Seed the draft whenever the target member changes; unsaved toggles are
  // discarded on dismiss (draft-only until Save).
  useEffect(() => {
    setPermDraft(member ? parsePermissionOverrides(member.team_permission_overrides) : {});
  }, [member]);

  function togglePermDraft(perm: Permission) {
    if (!member) return;
    // Baseline = the ROLE's effective permission (default + role override) —
    // roleHasPermission is reactive via the role-override cache.
    const base = roleHasPermission((member.user_role ?? '') as UserRole, perm);
    const cur = perm in permDraft ? permDraft[perm] : base;
    const next = !cur;
    setPermDraft(prev => {
      const copy = { ...prev };
      if (next === base) delete copy[perm]; else copy[perm] = next;
      return copy;
    });
  }

  async function handleSavePermDraft() {
    if (!member) return;
    if (isWriteBlocked()) return;
    setSavingPerms(true);
    try {
      await setMemberPermissionOverridesOnline(teamId, member.user_id, permDraft);
    } catch (e) {
      setSavingPerms(false);
      Alert.alert('Could not update permissions', (e as Error).message);
      return;
    }
    // Activity log is best-effort (and never blocks the change already committed above).
    try {
      appendLog({
        user_id: realUser?.id ?? null,
        team_id: teamId,
        action: 'user_permission_changed',
        entity_type: 'user',
        entity_id: member.user_id,
        from_location_id: null,
        to_location_id: null,
        quantity: null,
        unit: null,
        job_id: null,
        note: `${member.user_name ?? member.user_id} · ${teamName} team permissions updated`,
        metadata: JSON.stringify({ team_id: teamId, overrides: permDraft }),
        device_id: null,
      });
    } catch { /* logging is non-critical */ }
    setSavingPerms(false);
    onChanged();
    onClose();
  }

  // Mirror the host row's hierarchy gate inside the editor as a safety net
  // (the Perms button is already disabled for out-of-tier members).
  const permMemberLocked = !canActOnTarget((user?.role ?? '') as UserRole, (member?.user_role ?? '') as UserRole);

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll={false}>
      <Text style={s.title}>
        {member ? `${member.user_name ?? member.user_id} · Permissions` : 'Permissions'}
      </Text>
      {/* flexShrink:1 lets this ScrollView shrink within ModalSheet's maxHeight cap so it actually scrolls (RN defaults flexShrink:0). */}
      <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 4 }}>
        <Text style={s.permsIntro}>
          Overrides apply only within {teamName}. Toggling a permission back to its
          default removes the override.
        </Text>
        {member && TEAM_OVERRIDABLE_PERMISSIONS.map(perm => {
          const base = roleHasPermission((member.user_role ?? '') as UserRole, perm);
          const value = perm in permDraft ? permDraft[perm] : base;
          const modified = perm in permDraft;
          return (
            <View key={perm} style={s.permRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.permLabel}>{TEAM_PERMISSION_LABELS[perm]}</Text>
                {modified && <Text style={s.modifiedBadge}>overridden</Text>}
              </View>
              <Switch
                value={value}
                disabled={locked || savingPerms || permMemberLocked}
                onValueChange={() => togglePermDraft(perm)}
                trackColor={{ true: t.colors.primary, false: t.colors.border }}
              />
            </View>
          );
        })}

        <PrimaryButton
          label={savingPerms ? 'Saving…' : 'Save Permissions'}
          onPress={handleSavePermDraft}
          disabled={locked || savingPerms}
          style={{ marginTop: 8 }}
        />

        {/* TODO(gap): per-unit access grants section cut — depends on the
            unported src/db/queries/access.ts / unitAccess.ts / access/unitGrants.ts. */}
        {/* TODO(gap): personal locker toggle cut — depends on the unported
            src/access/personalLocker.ts. */}

        {locked && <MaintenanceBanner />}
        <TouchableOpacity style={s.cancelRow} onPress={onClose}>
          <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 14 },
  muted: { fontSize: 14, color: t.colors.textMuted },

  permsIntro: { fontSize: 13, color: t.colors.textSecondary, lineHeight: 18, marginBottom: 8 },
  permRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  permLabel: { fontSize: 14, color: t.colors.textPrimary },
  modifiedBadge: { fontSize: 11, color: t.colors.warning, fontWeight: '600', marginTop: 2 },

  cancelRow: { paddingVertical: 10, alignItems: 'center', marginBottom: 4 },
  linkText: { color: t.colors.primary, fontSize: 15, fontWeight: '600' },
  cancelText: { color: t.colors.textMuted },
});
