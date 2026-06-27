import React, { useState } from 'react';
import { View, TouchableOpacity, Text } from 'react-native';
import { useFormMode } from '../../hooks/useFormMode';
import { colors, spacing, fontSizes } from '../../theme';

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

  if (!isSimple) return <>{children}</>;

  return (
    <View>
      <TouchableOpacity
        onPress={() => setOpen(o => !o)}
        style={{
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.xs,
          marginTop: spacing.xs,
        }}
        activeOpacity={0.7}
      >
        <Text
          style={{
            color: colors.primaryText,
            fontSize: fontSizes.body,
            fontWeight: '500',
          }}
        >
          {open ? '⌃ Hide advanced fields' : '⌄ Show advanced fields'}
        </Text>
      </TouchableOpacity>
      {open && <View>{children}</View>}
    </View>
  );
}
