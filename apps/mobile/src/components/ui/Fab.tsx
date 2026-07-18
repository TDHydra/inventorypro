import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  onPress: () => void;
  /** Text next to the + (pill-shaped themes render it; circle/square themes ignore it). */
  label?: string;
  accessibilityLabel?: string;
}

/**
 * Floating action button — one implementation for the per-screen inline FABs.
 * Shape/size come from t.components.fab: 'circle' (Original), 'rounded-square',
 * or 'pill' (renders the label, e.g. "＋ Add").
 */
export function Fab({ onPress, label, accessibilityLabel }: Props) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const pill = t.components.fab.shape === 'pill';
  return (
    <TouchableOpacity
      style={pill ? s.fabPill : s.fab}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label ?? 'Add'}
    >
      <Text style={s.fabText}>＋{pill && label ? ` ${label}` : ''}</Text>
    </TouchableOpacity>
  );
}

const makeStyles = (t: Theme) => {
  const { shape, size } = t.components.fab;
  const radius = shape === 'circle' ? size / 2 : shape === 'rounded-square' ? t.radii.sm : size / 2;
  const base = {
    position: 'absolute' as const, bottom: 24, right: 24,
    backgroundColor: t.colors.accent, alignItems: 'center' as const, justifyContent: 'center' as const,
    ...t.shadows.fab,
  };
  return StyleSheet.create({
    fab: { ...base, width: size, height: size, borderRadius: radius },
    fabPill: { ...base, height: size, borderRadius: size / 2, paddingHorizontal: t.spacing.xl },
    fabText: {
      fontSize: 28, color: t.colors.onPrimary, lineHeight: 32,
      fontFamily: t.typography.fontFamily.medium,
    },
  });
};
