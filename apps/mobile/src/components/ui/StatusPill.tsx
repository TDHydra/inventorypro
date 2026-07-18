import { Text, View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export type PillTone = 'success' | 'warning' | 'danger' | 'primary' | 'accent' | 'neutral';

interface Props {
  label: string;
  tone?: PillTone;
  /** Override bg/text for data-driven colors (typeColors etc.). */
  color?: { bg: string; text: string };
  style?: StyleProp<ViewStyle>;
}

/**
 * Status/type badge — consolidates the ad-hoc pills across repairs, jobs,
 * teams, users, roles, audit-log, ScanReceipt. Tone maps to the theme's
 * semantic bg/text pairs; shape follows t.components.chip.variant so square-tag
 * themes (Classic/Futuristic) restyle every badge at once.
 */
export function StatusPill({ label, tone = 'neutral', color, style }: Props) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const c = color ?? toneColors(t, tone);
  return (
    <View style={[s.pill, { backgroundColor: c.bg }, style]}>
      <Text style={[s.text, { color: c.text }]} numberOfLines={1}>
        {t.typography.uppercaseLabels ? label.toUpperCase() : label}
      </Text>
    </View>
  );
}

function toneColors(t: Theme, tone: PillTone): { bg: string; text: string } {
  switch (tone) {
    case 'success': return { bg: t.colors.successBg, text: t.colors.successText };
    case 'warning': return { bg: t.colors.warningBg, text: t.colors.warningText };
    case 'danger': return { bg: t.colors.dangerBg, text: t.colors.danger };
    case 'primary': return { bg: t.colors.primaryBg, text: t.colors.primaryText };
    case 'accent': return { bg: t.colors.accentBg, text: t.colors.accent };
    default: return { bg: t.colors.surfaceAlt, text: t.colors.textStrong };
  }
}

const makeStyles = (t: Theme) => StyleSheet.create({
  pill: {
    borderRadius: t.components.chip.variant === 'square-tag' ? t.radii.sm : t.radii.pill,
    paddingHorizontal: t.spacing.sm,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: t.typography.fontSizes.caption,
    fontWeight: t.typography.weights.semibold,
    fontFamily: t.typography.fontFamily.medium,
    letterSpacing: t.typography.letterSpacing,
  },
});
