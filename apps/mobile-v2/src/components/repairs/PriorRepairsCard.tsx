import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { getRepairsForEntity, type Repair } from '../../repos/repairs';
import { isTerminalStatus } from '../../repos/taxonomy';
import { useDbQuery } from '@invenpro/core';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, Card, StatusPill } from '@invenpro/ui';

// Ported from apps/mobile/src/components/repairs/PriorRepairsCard.tsx (82 ln,
// Station C4). Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../db/queries/repairs' → '../../repos/repairs'
//   '../../db/queries/taxonomy' → '../../repos/taxonomy'
//   useDbQuery (hooks/useDbQuery) → '@invenpro/core'
//   ui/Card, ui/StatusPill, useThemedStyles → '@invenpro/ui'
//   '/(app)/(repairs)/[id]' route → '/(app)/repairs/[id]' (plain route)
// Straight port otherwise. Shared by repairs/[id].tsx (own history, excluding
// self) and — per Station C4 brief — equipment/[id].tsx / inventory/[id].tsx,
// resolving their prior wave-C-deferred repair-history stub comments.
export interface PriorRepairsCardProps {
  entityType: Repair['entity_type'];
  entityId: string;
  excludeRepairId?: string;
}

export function PriorRepairsCard({ entityType, entityId, excludeRepairId }: PriorRepairsCardProps) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const repairs = useDbQuery<Repair[]>(
    () => getRepairsForEntity(entityType, entityId).filter(r => r.id !== excludeRepairId),
    [entityType, entityId, excludeRepairId],
    ['repairs'],
  );
  if (repairs.length === 0) return null;
  return (
    <>
      <Text style={s.sectionTitle}>Repair history ({repairs.length})</Text>
      <Card variant="detail" style={s.card}>
        {repairs.map(pr => (
          <TouchableOpacity
            key={pr.id}
            style={s.priorRow}
            onPress={() => router.push({ pathname: '/(app)/repairs/[id]', params: { id: pr.id } })}
          >
            <View style={{ flex: 1 }}>
              <View style={s.priorHeadRow}>
                <StatusPill label={pr.status} tone={isTerminalStatus(pr.status) ? 'success' : 'neutral'} />
                <Text style={s.priorDate}>
                  {new Date(pr.completed_at ?? pr.updated_at).toLocaleDateString()}
                </Text>
              </View>
              {!!pr.notes && <Text style={s.priorNote} numberOfLines={2}>{pr.notes}</Text>}
            </View>
          </TouchableOpacity>
        ))}
      </Card>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  sectionTitle: {
    fontSize: 12, fontWeight: '700', color: t.colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 1, marginTop: 24, marginBottom: 8,
  },
  card: { marginBottom: 4 },
  priorRow: {
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail,
  },
  priorHeadRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  priorDate: { fontSize: 12, color: t.colors.textMuted, marginLeft: 'auto' },
  priorNote: { fontSize: 13, color: t.colors.textSecondary, marginTop: 4 },
});
