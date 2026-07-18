// Small, display-only status/type pill for list rows and detail headers.
// Replaces per-screen inline colored <Text> snippets with a single consistent
// component.
//
// Usage:
//   <StatusBadge label="Active" tone="success" />
//   <StatusBadge label="Overdue" tone="danger" size="md" />
//   <TypeBadge type={item.category} />
//
// Both are display-only (no onPress) — for an interactive/selectable pill use
// FilterChip instead.

import { Text, View, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';
import { autoTypeColor } from '../../constants/typeColors';

export type BadgeTone = 'default' | 'primary' | 'accent' | 'success' | 'warning' | 'danger';

interface StatusBadgeProps {
  label: string;
  tone?: BadgeTone;
  size?: 'sm' | 'md';
}

// Append an alpha channel to an existing 6-digit hex token to derive a light
// tint, rather than inventing a new "*Bg" color that doesn't exist yet.
function withAlpha(hex: string, alpha: string): string {
  return `${hex}${alpha}`;
}

const TONE_STYLES: Record<BadgeTone, { bg: string; fg: string; border?: string }> = {
  default: { bg: colors.surface, fg: colors.textSecondary, border: colors.border },
  primary: { bg: colors.primaryBg, fg: colors.primary },
  accent: { bg: colors.accentBg, fg: colors.accent },
  success: { bg: withAlpha(colors.success, '1A'), fg: colors.success },
  warning: { bg: withAlpha(colors.warning, '1A'), fg: colors.warning },
  danger: { bg: colors.dangerBg, fg: colors.danger },
};

function Badge({
  label,
  bg,
  fg,
  border,
  size = 'sm',
}: {
  label: string;
  bg: string;
  fg: string;
  border?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <View
      style={[
        s.pill,
        size === 'md' ? s.pillMd : s.pillSm,
        { backgroundColor: bg },
        border ? { borderWidth: 1, borderColor: border } : null,
      ]}
    >
      <Text style={[s.text, size === 'md' ? s.textMd : s.textSm, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function StatusBadge({ label, tone = 'default', size = 'sm' }: StatusBadgeProps) {
  const { bg, fg, border } = TONE_STYLES[tone];
  return <Badge label={label} bg={bg} fg={fg} border={border} size={size} />;
}

interface TypeBadgeProps {
  type: string;
  size?: 'sm' | 'md';
}

export function TypeBadge({ type, size = 'sm' }: TypeBadgeProps) {
  const trimmed = type?.trim();
  if (!trimmed) {
    const { bg, fg, border } = TONE_STYLES.default;
    return <Badge label={type ?? ''} bg={bg} fg={fg} border={border} size={size} />;
  }
  const accent = autoTypeColor(trimmed);
  return <Badge label={trimmed} bg={withAlpha(accent, '1A')} fg={accent} size={size} />;
}

const s = StyleSheet.create({
  pill: {
    borderRadius: radii.xl,
    alignSelf: 'flex-start',
    justifyContent: 'center',
  },
  pillSm: { paddingHorizontal: spacing.sm, paddingVertical: 2 },
  pillMd: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  text: { fontWeight: '600' },
  textSm: { fontSize: fontSizes.xs },
  textMd: { fontSize: fontSizes.sm },
});
