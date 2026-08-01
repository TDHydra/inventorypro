import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import WheelPicker from '@quidone/react-native-wheel-picker';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

// Themed time-of-day wheel (#184 follow-up): JS-only per the kit's hard
// constraint — @quidone/react-native-wheel-picker animates with the RN
// Animated API, no native module, so it hotloads and needs no rebuild.
// Values are minutes-since-midnight to match schedule_assignments.
// Web gets a twin (TimeWheelPicker.web.tsx) — keep the props in sync.
//
// Usage:
//   <TimeWheelPicker label="Start" valueMinute={start} onChange={setStart} />

export interface TimeWheelPickerProps {
  label: string;
  valueMinute: number;
  onChange: (minute: number) => void;
  minMinute?: number; // inclusive, default 5:00 AM
  maxMinute?: number; // inclusive, default 9:00 PM
  stepMinutes?: number; // default 30
}

export function formatTimeOfDay(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export function buildTimeOptions(minMinute: number, maxMinute: number, stepMinutes: number) {
  const out: { value: number; label: string }[] = [];
  for (let m = minMinute; m <= maxMinute; m += stepMinutes) {
    out.push({ value: m, label: formatTimeOfDay(m) });
  }
  return out;
}

const ITEM_HEIGHT = 38;

export function TimeWheelPicker({
  label,
  valueMinute,
  onChange,
  minMinute = 300,
  maxMinute = 1260,
  stepMinutes = 30,
}: TimeWheelPickerProps) {
  const s = useThemedStyles(makeStyles);
  const data = useMemo(
    () => buildTimeOptions(minMinute, maxMinute, stepMinutes),
    [minMinute, maxMinute, stepMinutes],
  );

  return (
    <View style={s.col}>
      <Text style={s.label}>{label}</Text>
      <WheelPicker
        data={data}
        value={valueMinute}
        onValueChanged={({ item }) => onChange(item.value)}
        itemHeight={ITEM_HEIGHT}
        visibleItemCount={5}
        width={132}
        enableScrollByTapOnItem
        overlayItemStyle={s.overlay}
        renderItem={({ item }) => (
          <View style={s.item}>
            <Text style={s.itemText}>{item.label}</Text>
          </View>
        )}
      />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  col: { alignItems: 'center' },
  label: {
    fontSize: t.typography.fontSizes.caption, fontWeight: '700',
    color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: t.spacing.xs,
  },
  overlay: { backgroundColor: t.colors.primaryBg, borderRadius: t.radii.md, opacity: 0.35 },
  item: { height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  itemText: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '600' },
});
