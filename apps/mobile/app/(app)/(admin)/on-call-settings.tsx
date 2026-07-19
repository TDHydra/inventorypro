import { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import { setAppConfigLocal } from '../../../src/db/appConfig';
import { appendOutbox } from '../../../src/sync/outbox';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { SelectField } from '../../../src/components/ui/SelectField';
import { DragList } from '../../../src/components/ui/DragList';
import { getAssignableCrews, getWeekBoundary, getRotation } from '../../../src/db/queries/oncall';
import type { WeekStartsOn } from '../../../src/components/oncall/weekMath';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

// Writes a synced `app_config` value: locally + through the outbox so it reaches
// the server (same write path as notification-routing.tsx's `setAppConfigSynced`
// — INSERT is the outbox's full-row upsert op; the server applies
// ON CONFLICT (key) DO UPDATE).
function setAppConfigSynced(key: string, value: string): void {
  setAppConfigLocal(key, value);
  appendOutbox('INSERT', 'app_config', {
    key,
    value,
    updated_at: new Date().toISOString(),
  });
}

const DAY_OPTIONS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  .map((label, i) => ({ id: String(i), label }));
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ id: String(h), label: `${String(h).padStart(2, '0')}:00` }));

const ROTATION_ROW_HEIGHT = 56;

// Admin screen for the on-call week boundary (app_config 'on_call_week_boundary',
// JSON {day,hour}) and the crew rotation order ('on_call_rotation', ordered JSON
// subteam-id array consumed by ensureRotationFill). Gated on `system_settings`
// like the other admin sub-screens.
export default function OnCallSettingsScreen() {
  const s = useThemedStyles(makeStyles);
  const isAdmin = usePermission('system_settings');
  const version = useTableVersion(['app_config', 'subteams']);

  const [boundary, setBoundary] = useState(() => getWeekBoundary());
  const [rotation, setRotation] = useState<string[]>(() => getRotation());
  const [dragActive, setDragActive] = useState(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const crews = useMemo(() => getAssignableCrews(), [version]);
  const addOptions = useMemo(
    () => crews
      .filter(c => !rotation.includes(c.id))
      .map(c => ({ id: c.id, label: c.name, sublabel: c.team_name ?? undefined })),
    [crews, rotation],
  );

  function saveBoundary(next: { day: WeekStartsOn; hour: number }): void {
    setBoundary(next);
    setAppConfigSynced('on_call_week_boundary', JSON.stringify({ day: next.day, hour: next.hour }));
  }

  function saveRotation(next: string[]): void {
    setRotation(next);
    setAppConfigSynced('on_call_rotation', JSON.stringify(next));
  }

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'On-Call Settings', headerShown: true }} />
        <Text style={s.muted}>You don’t have access to on-call settings.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'On-Call Settings', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content} scrollEnabled={!dragActive}>
        {/* ── Week boundary ─────────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Week boundary</Text>
          <View style={s.card}>
            <SelectField
              label="Week flips on"
              value={String(boundary.day)}
              options={DAY_OPTIONS}
              onSelect={(dayId) => saveBoundary({ day: Number(dayId) as WeekStartsOn, hour: boundary.hour })}
            />
            <SelectField
              label="At (local time)"
              value={String(boundary.hour)}
              options={HOUR_OPTIONS}
              onSelect={(hourId) => saveBoundary({ day: boundary.day, hour: Number(hourId) })}
            />
            <Text style={s.helper}>
              Existing week assignments keep their dates; future weeks re-fill on
              the new boundary.
            </Text>
          </View>
        </View>

        {/* ── Rotation order ────────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Crew rotation</Text>
          <View style={s.card}>
            {rotation.length === 0 ? (
              <Text style={s.muted}>No crews in the rotation yet.</Text>
            ) : (
              <DragList
                items={rotation}
                keyExtractor={(id) => id}
                rowHeight={ROTATION_ROW_HEIGHT}
                onReorder={(orderedKeys) => saveRotation(orderedKeys)}
                onDragActiveChange={setDragActive}
                renderRow={(id, api) => (
                  <View style={[s.rotationRow, api.index > 0 && s.rotationRowBorder]}>
                    <View
                      {...api.panHandlers}
                      style={s.dragHandle}
                      accessibilityLabel="Drag to reorder crew"
                    >
                      <Text style={s.dragGlyph}>≡</Text>
                    </View>
                    <Text style={s.rotationIndex}>{api.index + 1}.</Text>
                    <Text style={s.rotationName} numberOfLines={1}>
                      {crews.find(c => c.id === id)?.name ?? 'Unknown crew'}
                    </Text>
                    <TouchableOpacity
                      onPress={() => saveRotation(rotation.filter(r => r !== id))}
                      style={s.removeBtn}
                      hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                    >
                      <Text style={s.removeBtnText}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                )}
              />
            )}
            <SelectField
              label="Add crew to rotation"
              value={null}
              options={addOptions}
              placeholder="Select a crew…"
              onSelect={(id) => saveRotation([...rotation, id])}
            />
            <Text style={s.helper}>
              Weeks auto-fill by cycling this list. Manually assigning a week
              overrides just that week.
            </Text>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg, gap: t.spacing.lg, paddingBottom: 48 },

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl,
    backgroundColor: t.colors.background,
  },
  muted: {
    fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center',
  },

  sectionTitle: {
    fontSize: t.typography.fontSizes.lg,
    fontWeight: '700',
    color: t.colors.textPrimary,
    marginBottom: t.spacing.sm,
  },
  card: {
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.base,
    gap: t.spacing.sm,
  },
  helper: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, lineHeight: 20 },

  rotationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROTATION_ROW_HEIGHT,
    gap: t.spacing.sm,
  },
  rotationRowBorder: { borderTopWidth: 1, borderTopColor: t.colors.border },
  dragHandle: {
    paddingHorizontal: t.spacing.sm,
    height: '100%',
    justifyContent: 'center',
  },
  dragGlyph: { fontSize: 18, color: t.colors.textSecondary },
  rotationIndex: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary },
  rotationName: { flex: 1, fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  removeBtn: {
    paddingHorizontal: t.spacing.sm,
    paddingVertical: t.spacing.xs,
  },
  removeBtnText: { fontSize: t.typography.fontSizes.body2, color: t.colors.danger, fontWeight: '600' },
});
