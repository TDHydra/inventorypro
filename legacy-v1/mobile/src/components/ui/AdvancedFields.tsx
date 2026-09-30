import React, { useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useFormMode } from '../../hooks/useFormMode';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

/**
 * Wraps a form's optional (advanced) field group.
 * - Detailed mode: renders children directly — no expander, identical to today.
 * - Simple mode: collapses children behind a "⌄ Show advanced fields" toggle
 *   (local state, default collapsed). Tapping reveals them inline without
 *   leaving Simple mode.
 */
export function AdvancedFields({ children }: { children: React.ReactNode }) {
  const { isSimple } = useFormMode();
  const [open, setOpen] = useState(false);
  const s = useThemedStyles(makeStyles);

  if (!isSimple) return <>{children}</>;

  return (
    <View>
      <TouchableOpacity onPress={() => setOpen(o => !o)} style={s.toggle} activeOpacity={0.7}>
        <Text style={s.toggleText}>
          {open ? '⌃ Hide advanced fields' : '⌄ Show advanced fields'}
        </Text>
      </TouchableOpacity>
      {open && <View>{children}</View>}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  toggle: {
    paddingVertical: t.spacing.sm,
    paddingHorizontal: t.spacing.xs,
    marginTop: t.spacing.xs,
  },
  toggleText: {
    color: t.colors.primaryText,
    fontSize: t.typography.fontSizes.body,
    fontWeight: t.typography.weights.medium,
  },
});
