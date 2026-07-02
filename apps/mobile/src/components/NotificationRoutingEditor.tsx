import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ROLE_DISPLAY_NAMES, UserRole } from '../constants/roles';
import { getAppConfig } from '../db/appConfig';
import { getAllTeams } from '../db/queries/teams';
import { getAllActiveUsers } from '../db/queries/users';
import { SearchablePicker } from './SearchablePicker';
import type { PickerOption } from './SearchablePicker';
import { colors, spacing, radii, fontSizes } from '../theme';

// ── Channels ──────────────────────────────────────────────────────────────
// The four server-side notification channels. Each is persisted as an
// `app_config` value under `notify_route_<key>` holding a `RouteConfig` JSON.
// These are *additive* recipients: the server unions them with each channel's
// intrinsic recipients (see resolveRecipients in apps/api/src/lib/notifications).

export type RoutingChannel = 'assignment' | 'low_stock' | 'checkout_idle' | 'approvals';

interface RouteConfig {
  roles: string[];
  teams: string[];
  users: string[];
}

const CHANNELS: { key: RoutingChannel; label: string; note: string }[] = [
  { key: 'assignment', label: 'Repair assignment', note: 'Extra cc — the assignee is always notified.' },
  { key: 'low_stock', label: 'Low stock', note: 'Added to the default admins & franchise managers.' },
  { key: 'checkout_idle', label: 'Checkout idle', note: "Added to the user's team manager." },
  { key: 'approvals', label: 'Approval requests', note: 'Who reviews approval requests (defaults to team managers).' },
];

const ROLE_KEYS = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];

// Parse a stored route value, tolerating unset / malformed JSON.
function parseRoute(raw: string | null): RouteConfig {
  if (!raw) return { roles: [], teams: [], users: [] };
  try {
    const p = JSON.parse(raw) as Partial<RouteConfig>;
    return {
      roles: Array.isArray(p.roles) ? p.roles : [],
      teams: Array.isArray(p.teams) ? p.teams : [],
      users: Array.isArray(p.users) ? p.users : [],
    };
  } catch {
    return { roles: [], teams: [], users: [] };
  }
}

interface Props {
  /** Synced config writer — reuse settings.tsx's `setAppConfigSynced`. */
  onSave: (key: string, value: string) => void;
}

// Admin editor for the four notification routing channels. Each channel gets
// multi-select chips for roles and teams plus a searchable user picker; the
// selection serializes to `{roles,teams,users}` JSON and is written through the
// synced app_config path so the server resolver can read it.
export function NotificationRoutingEditor({ onSave }: Props) {
  const teams = useMemo(() => getAllTeams(), []);
  const userOptions = useMemo<PickerOption[]>(
    () => getAllActiveUsers().map(u => ({ id: u.id, label: u.name })),
    [],
  );
  const userNameById = useMemo(
    () => new Map(userOptions.map(o => [o.id, o.label])),
    [userOptions],
  );

  const [routes, setRoutes] = useState<Record<RoutingChannel, RouteConfig>>(() => {
    const out = {} as Record<RoutingChannel, RouteConfig>;
    for (const c of CHANNELS) out[c.key] = parseRoute(getAppConfig(`notify_route_${c.key}`));
    return out;
  });

  const update = (channel: RoutingChannel, next: RouteConfig) => {
    setRoutes(prev => ({ ...prev, [channel]: next }));
    onSave(`notify_route_${channel}`, JSON.stringify(next));
  };

  const toggleRole = (channel: RoutingChannel, role: string) => {
    const cur = routes[channel];
    const has = cur.roles.includes(role);
    update(channel, { ...cur, roles: has ? cur.roles.filter(r => r !== role) : [...cur.roles, role] });
  };

  const toggleTeam = (channel: RoutingChannel, teamId: string) => {
    const cur = routes[channel];
    const has = cur.teams.includes(teamId);
    update(channel, { ...cur, teams: has ? cur.teams.filter(t => t !== teamId) : [...cur.teams, teamId] });
  };

  const addUser = (channel: RoutingChannel, userId: string) => {
    const cur = routes[channel];
    if (cur.users.includes(userId)) return;
    update(channel, { ...cur, users: [...cur.users, userId] });
  };

  const removeUser = (channel: RoutingChannel, userId: string) => {
    const cur = routes[channel];
    update(channel, { ...cur, users: cur.users.filter(u => u !== userId) });
  };

  return (
    <View style={{ gap: spacing.lg }}>
      {CHANNELS.map(ch => {
        const cfg = routes[ch.key];
        return (
          <View key={ch.key} style={s.block}>
            <Text style={s.blockTitle}>{ch.label}</Text>
            <Text style={s.blockNote}>{ch.note}</Text>

            {/* Roles */}
            <Text style={s.groupLabel}>Roles</Text>
            <View style={s.chipWrap}>
              {ROLE_KEYS.map(role => {
                const active = cfg.roles.includes(role);
                return (
                  <TouchableOpacity
                    key={role}
                    style={[s.chip, active && s.chipActive]}
                    onPress={() => toggleRole(ch.key, role)}
                  >
                    <Text style={[s.chipText, active && s.chipTextActive]}>{ROLE_DISPLAY_NAMES[role]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Teams */}
            {teams.length > 0 && (
              <>
                <Text style={s.groupLabel}>Teams</Text>
                <View style={s.chipWrap}>
                  {teams.map(team => {
                    const active = cfg.teams.includes(team.id);
                    return (
                      <TouchableOpacity
                        key={team.id}
                        style={[s.chip, active && s.chipActive]}
                        onPress={() => toggleTeam(ch.key, team.id)}
                      >
                        <Text style={[s.chipText, active && s.chipTextActive]}>{team.name}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </>
            )}

            {/* Users */}
            <Text style={s.groupLabel}>Specific people</Text>
            {cfg.users.length > 0 && (
              <View style={s.chipWrap}>
                {cfg.users.map(uid => (
                  <TouchableOpacity
                    key={uid}
                    style={[s.chip, s.chipActive]}
                    onPress={() => removeUser(ch.key, uid)}
                  >
                    <Text style={[s.chipText, s.chipTextActive]}>{userNameById.get(uid) ?? 'Unknown'} ✕</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <SearchablePicker
              placeholder="Add a person…"
              options={userOptions}
              value={null}
              onSelect={(opt) => addUser(ch.key, opt.id)}
            />
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  block: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.base,
    gap: spacing.sm,
  },
  blockTitle: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary },
  blockNote: { fontSize: fontSizes.body2, color: colors.textSecondary },
  groupLabel: {
    fontSize: fontSizes.caption,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.sm,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
});
