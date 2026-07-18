import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props { icon?: string; title: string; subtitle?: string; cta?: { label: string; onPress: () => void }; }
export function EmptyState({ icon, title, subtitle, cta }: Props) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.wrap}>
      {icon ? <Text style={s.icon}>{icon}</Text> : null}
      <Text style={s.title}>{title}</Text>
      {subtitle ? <Text style={s.sub}>{subtitle}</Text> : null}
      {cta ? (
        <TouchableOpacity style={s.cta} onPress={cta.onPress} activeOpacity={0.85}>
          <Text style={s.ctaText}>{cta.label}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: t.spacing.xxl, gap: t.spacing.sm },
  icon: { fontSize: 36, marginBottom: t.spacing.xs },
  title: { fontSize: t.typography.fontSizes.base, fontWeight: '700', color: t.colors.textSecondary, textAlign: 'center' },
  sub: { fontSize: t.typography.fontSizes.body2, color: t.colors.textMuted, textAlign: 'center' },
  cta: { marginTop: t.spacing.sm, backgroundColor: t.colors.primary, borderRadius: t.radii.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
  ctaText: { color: t.colors.onPrimary, fontWeight: '700', fontSize: t.typography.fontSizes.body },
});
