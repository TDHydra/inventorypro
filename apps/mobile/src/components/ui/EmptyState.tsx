import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, fontSizes, radii } from '../../theme';

interface Props { icon?: string; title: string; subtitle?: string; cta?: { label: string; onPress: () => void }; }
export function EmptyState({ icon, title, subtitle, cta }: Props) {
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
const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.sm },
  icon: { fontSize: 36, marginBottom: spacing.xs },
  title: { fontSize: fontSizes.base, fontWeight: '700', color: colors.textSecondary, textAlign: 'center' },
  sub: { fontSize: fontSizes.body2, color: colors.textMuted, textAlign: 'center' },
  cta: { marginTop: spacing.sm, backgroundColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  ctaText: { color: '#fff', fontWeight: '700', fontSize: fontSizes.body },
});
