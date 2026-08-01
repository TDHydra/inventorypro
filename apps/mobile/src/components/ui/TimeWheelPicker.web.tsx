import { useEffect, useMemo, useRef } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { buildTimeOptions, type TimeWheelPickerProps } from './TimeWheelPicker';

// Web twin of TimeWheelPicker (ModalSheet.web.tsx convention — keep the props
// in sync with the native file). Momentum wheel physics are unreliable under
// react-native-web, so the web build gets a plain scrollable list with the
// selected time highlighted; same minutes-since-midnight contract.

const ITEM_HEIGHT = 38;
const VISIBLE = 5;

export function TimeWheelPicker({
  label,
  valueMinute,
  onChange,
  minMinute = 300,
  maxMinute = 1260,
  stepMinutes = 30,
}: TimeWheelPickerProps) {
  const s = useThemedStyles(makeStyles);
  const scrollRef = useRef<ScrollView>(null);
  const data = useMemo(
    () => buildTimeOptions(minMinute, maxMinute, stepMinutes),
    [minMinute, maxMinute, stepMinutes],
  );

  // Keep the selected row in view (centered) when the value changes.
  useEffect(() => {
    const idx = data.findIndex(d => d.value === valueMinute);
    if (idx < 0) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, (idx - (VISIBLE - 1) / 2) * ITEM_HEIGHT), animated: false });
  }, [valueMinute, data]);

  return (
    <View style={s.col}>
      <Text style={s.label}>{label}</Text>
      <ScrollView ref={scrollRef} style={s.list} showsVerticalScrollIndicator>
        {data.map(d => (
          <Pressable
            key={d.value}
            style={[s.item, d.value === valueMinute && s.itemSelected]}
            onPress={() => onChange(d.value)}
          >
            <Text style={[s.itemText, d.value === valueMinute && s.itemTextSelected]}>{d.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
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
  list: {
    height: ITEM_HEIGHT * VISIBLE, width: 132,
    borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radii.md,
  },
  item: { height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  itemSelected: { backgroundColor: t.colors.primaryBg },
  itemText: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '600' },
  itemTextSelected: { color: t.colors.primaryText },
});
