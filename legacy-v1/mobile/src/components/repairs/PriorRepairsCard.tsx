import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { getRepairsForEntity, Repair } from '../../db/queries/repairs';
import { isTerminalStatus } from '../../db/queries/taxonomy';
import { useDbQuery } from '../../hooks/useDbQuery';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import type { Theme } from '../../themes/types';
import { Card } from '../ui/Card';
import { StatusPill } from '../ui/StatusPill';

export interface PriorRepairsCardProps {
  entityType: Repair['entity_type'];
  entityId: string;
  /** Exclude one ticket (the open one its own detail page is showing) from the list. */
  excludeRepairId?: string;
}

/**
 * Past repair tickets against a single asset (equipment unit / item / vehicle),
 * most-recently-updated first — #178 Part 3: "opening an item surfaces past
 * faults + resolutions for the same asset". Originally inline on the repair
 * detail screen (app/(app)/(repairs)/[id].tsx); extracted here so the
 * equipment/inventory detail pages can show the same history without a
 * parallel implementation (#178 close-out, grow-don't-duplicate).
 *
 * Self-contained like ActivityFeed/MediaGallery — owns its own reactivity
 * (useDbQuery/repairs, #64 per-table granularity) and renders nothing when
 * the asset has no repair history, so hosts never need an empty-state check.
 */
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
            onPress={() => router.push({ pathname: '/(app)/(repairs)/[id]', params: { id: pr.id } })}
          >
            <View style={{ flex: 1 }}>
              <View style={s.priorHeadRow}>
                <StatusPill label={pr.status} tone={isTerminalStatus(pr.status) ? 'success' : 'neutral'} />
                <Text style={s.priorDate}>
                  {new Date(pr.completed_at ?? pr.updated_at).toLocaleDateString()}
                </Text>
              </View>
              {!!pr.notes && (
                <Text style={s.priorNote} numberOfLines={2}>{pr.notes}</Text>
              )}
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
    flexDirection: 'row', alignItems: 'flex-start', paddingVertical: t.spacing.sm,
    borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail,
  },
  priorHeadRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  priorDate: { fontSize: 12, color: t.colors.textMuted },
  priorNote: { fontSize: 13, color: t.colors.textSecondary, marginTop: 4 },
});
