import { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch, ActivityIndicator } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { usePermission } from '../../../src/hooks/usePermission';
import { useFocusRefresh } from '../../../src/hooks/useFocusRefresh';
import { useSession } from '../../../src/hooks/useSession';
import { ROLE_DISPLAY_NAMES, UserRole } from '../../../src/constants/roles';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { getAllTeams, getTeamMembers } from '../../../src/db/queries/teams';
import { getValidJwt } from '../../../src/auth/session';
import { AppInput } from '../../../src/components/ui/AppInput';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

const ROLE_OPTIONS = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];

// Estimates the recipient set locally so the composer can show a live count
// before sending. Mirrors the server's resolveAudience: everyone → all active
// users; else union of selected roles' members + selected teams' members; the
// sender is excluded. The server recomputes authoritatively at send time — this
// is a best-effort local preview from the last-synced tables.
function estimateRecipients(
  everyone: boolean,
  roles: Set<string>,
  teams: Set<string>,
  senderId: string | undefined,
): number {
  const ids = new Set<string>();
  const active = getAllActiveUsers();
  if (everyone) {
    active.forEach(u => ids.add(u.id));
  } else {
    if (roles.size) active.forEach(u => { if (roles.has(u.role)) ids.add(u.id); });
    if (teams.size) {
      teams.forEach(teamId => {
        getTeamMembers(teamId).forEach(m => ids.add(m.user_id));
      });
    }
  }
  if (senderId) ids.delete(senderId);
  return ids.size;
}

export default function BroadcastScreen() {
  const router = useRouter();
  const canSend = usePermission('send_notifications');
  const { user } = useSession();
  const refreshKey = useFocusRefresh();

  const [everyone, setEveryone] = useState(false);
  const [roles, setRoles] = useState<Set<string>>(() => new Set());
  const [teams, setTeams] = useState<Set<string>>(() => new Set());
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const allTeams = useMemo(() => getAllTeams(), [refreshKey]);
  const recipientCount = useMemo(
    () => estimateRecipients(everyone, roles, teams, user?.id),
    [everyone, roles, teams, user?.id, refreshKey],
  );

  function toggleRole(role: string) {
    setRoles(prev => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role); else next.add(role);
      return next;
    });
  }
  function toggleTeam(teamId: string) {
    setTeams(prev => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
      return next;
    });
  }

  const canSubmit =
    !sending && title.trim().length > 0 && body.trim().length > 0 &&
    (everyone || roles.size > 0 || teams.size > 0);

  async function handleSend() {
    if (!canSubmit) return;
    setSending(true);
    try {
      const jwt = await getValidJwt();
      if (!jwt) {
        Alert.alert('Offline', 'Connect to the server to send a broadcast.');
        return;
      }
      const audience = everyone
        ? { everyone: true }
        : { roles: [...roles], teams: [...teams] };
      const res = await fetch(`${API_BASE}/notifications/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ audience, title: title.trim(), body: body.trim() }),
      });
      if (res.ok) {
        const data = (await res.json()) as { recipients?: number };
        Alert.alert('Broadcast sent', `Delivered to ${data.recipients ?? recipientCount} recipient(s).`, [
          { text: 'OK', onPress: () => router.back() },
        ]);
      } else if (res.status === 403) {
        Alert.alert('Not allowed', 'You do not have permission to send broadcasts.');
      } else if (res.status === 400) {
        Alert.alert('No recipients', 'The selected audience has no active recipients.');
      } else if (res.status === 429) {
        Alert.alert('Slow down', 'Too many broadcasts. Please wait a moment and try again.');
      } else {
        Alert.alert('Send failed', `Could not send the broadcast (${res.status}).`);
      }
    } catch {
      Alert.alert('Send failed', 'Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  if (!canSend) {
    return (
      <>
        <Stack.Screen options={{ title: 'Broadcast', headerShown: true }} />
        <View style={s.deniedWrap}>
          <Text style={s.deniedText}>You do not have permission to send broadcasts.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Broadcast', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>

        {/* ── Audience ─────────────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Audience</Text>
          <View style={s.card}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.rowLabel}>Everyone</Text>
                <Text style={s.rowSub}>Send to every active user.</Text>
              </View>
              <Switch value={everyone} onValueChange={setEveryone} />
            </View>

            {!everyone && (
              <>
                <View style={s.divider} />
                <View style={s.blockPad}>
                  <Text style={s.rowLabel}>Roles</Text>
                  <View style={s.chipWrap}>
                    {ROLE_OPTIONS.map(role => {
                      const on = roles.has(role);
                      return (
                        <TouchableOpacity
                          key={role}
                          style={[s.chip, on && s.chipActive]}
                          onPress={() => toggleRole(role)}
                        >
                          <Text style={[s.chipText, on && s.chipTextActive]}>{ROLE_DISPLAY_NAMES[role]}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>

                <View style={s.divider} />
                <View style={s.blockPad}>
                  <Text style={s.rowLabel}>Teams</Text>
                  {allTeams.length === 0 ? (
                    <Text style={s.rowSub}>No teams yet.</Text>
                  ) : (
                    <View style={s.chipWrap}>
                      {allTeams.map(t => {
                        const on = teams.has(t.id);
                        return (
                          <TouchableOpacity
                            key={t.id}
                            style={[s.chip, on && s.chipActive]}
                            onPress={() => toggleTeam(t.id)}
                          >
                            <Text style={[s.chipText, on && s.chipTextActive]}>{t.name}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  )}
                </View>
              </>
            )}

            <View style={s.divider} />
            <View style={s.infoBlock}>
              <Text style={s.rowSub}>Estimated recipients: {recipientCount}</Text>
            </View>
          </View>
        </View>

        {/* ── Message ──────────────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Message</Text>
          <View style={s.card}>
            <View style={s.blockPad}>
              <Text style={s.rowLabel}>Title</Text>
              <AppInput
                value={title}
                onChangeText={setTitle}
                placeholder="Short headline"
                maxLength={120}
                style={{ marginTop: spacing.sm }}
              />
            </View>
            <View style={s.divider} />
            <View style={s.blockPad}>
              <Text style={s.rowLabel}>Body</Text>
              <AppInput
                value={body}
                onChangeText={setBody}
                placeholder="What do you want everyone to know?"
                maxLength={1000}
                multiline
                style={{ marginTop: spacing.sm, minHeight: 96, textAlignVertical: 'top' }}
              />
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={[s.sendBtn, !canSubmit && s.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!canSubmit}
        >
          {sending
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.sendBtnText}>Send broadcast</Text>}
        </TouchableOpacity>

      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },

  deniedWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  deniedText: { fontSize: fontSizes.body, color: colors.textSecondary, textAlign: 'center' },

  sectionTitle: {
    fontSize: fontSizes.caption,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
  },
  rowLabel: { fontSize: fontSizes.body, color: colors.textPrimary, fontWeight: '500' },
  rowSub: { fontSize: fontSizes.body2, color: colors.textSecondary, marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.base },
  blockPad: { paddingHorizontal: spacing.base, paddingVertical: spacing.base },
  infoBlock: { paddingHorizontal: spacing.base, paddingVertical: spacing.md },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: spacing.sm },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.textDisabled,
    backgroundColor: colors.background,
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { fontSize: fontSizes.body2, fontWeight: '600', color: '#475569' },
  chipTextActive: { color: '#fff' },

  sendBtn: {
    backgroundColor: colors.brand,
    borderRadius: radii.lg,
    paddingVertical: spacing.base,
    alignItems: 'center',
  },
  sendBtnDisabled: { backgroundColor: colors.textDisabled },
  sendBtnText: { color: '#fff', fontSize: fontSizes.body, fontWeight: '700' },
});
