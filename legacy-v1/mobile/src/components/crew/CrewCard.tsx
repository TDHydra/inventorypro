import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Card } from '../ui/Card';
import type { Crew } from '../../db/queries/subteams';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

// One crew (subteam) as a card: name, lead (badged like the Manager badge on
// the teams detail roster), helpers listed below. Presentation-only — tap
// behavior and any action affordances (`right`, e.g. Edit/Remove links) are
// the caller's.
export function CrewCard({
  crew,
  onPressMember,
  right,
}: {
  crew: Crew;
  onPressMember?: (userId: string) => void;
  right?: React.ReactNode;
}) {
  const s = useThemedStyles(makeStyles);

  const renderMember = (member: { id: string; name: string }, isLead: boolean, last: boolean) => {
    const row = (
      <View style={[s.memberRow, !last && s.divider]}>
        <Text style={s.memberName} numberOfLines={1}>{member.name}</Text>
        {isLead ? (
          <View style={s.leadBadge}>
            <Text style={s.leadBadgeText}>Lead</Text>
          </View>
        ) : (
          <Text style={s.helperLabel}>Helper</Text>
        )}
      </View>
    );
    if (!onPressMember) return <View key={member.id}>{row}</View>;
    return (
      <TouchableOpacity
        key={member.id}
        onPress={() => onPressMember(member.id)}
        accessibilityLabel={`Open ${member.name}`}
      >
        {row}
      </TouchableOpacity>
    );
  };

  const memberCount = (crew.lead ? 1 : 0) + crew.helpers.length;

  return (
    <Card variant="detail">
      <View style={s.headerRow}>
        <Text style={s.crewName} numberOfLines={1}>{crew.name}</Text>
        {right}
      </View>
      {memberCount === 0 ? (
        <Text style={s.empty}>No members assigned.</Text>
      ) : (
        <>
          {crew.lead && renderMember(crew.lead, true, crew.helpers.length === 0)}
          {crew.helpers.map((h, i) => renderMember(h, false, i === crew.helpers.length - 1))}
        </>
      )}
    </Card>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: t.spacing.sm, marginBottom: t.spacing.xs,
  },
  crewName: {
    flex: 1, fontSize: t.typography.fontSizes.base, fontWeight: t.typography.weights.bold,
    color: t.colors.textPrimary,
  },
  empty: { fontSize: t.typography.fontSizes.sm, color: t.colors.textMuted, marginTop: t.spacing.xs },

  memberRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: t.spacing.sm },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  memberName: { flex: 1, fontSize: t.typography.fontSizes.md, color: t.colors.textPrimary, fontWeight: t.typography.weights.semibold },

  // Mirrors the mgrBadge pill on (teams)/[id].tsx.
  leadBadge: {
    backgroundColor: t.colors.primaryBg, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  leadBadgeText: { color: t.colors.primaryText, fontSize: t.typography.fontSizes.xs, fontWeight: t.typography.weights.bold },
  helperLabel: { color: t.colors.textSecondary, fontSize: t.typography.fontSizes.xs, fontWeight: t.typography.weights.semibold },
});
