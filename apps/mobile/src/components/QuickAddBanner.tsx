import { TouchableOpacity, View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { usePermission } from '../hooks/usePermission';
import { useQuickAddBannerHidden, hideQuickAddBanner } from '../lib/quickAddBanner';
import { track } from '../telemetry';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';

/**
 * Big "Quick Add" call-to-action, shown to any role granted the `quick_add`
 * permission. The X in the bottom-right corner hides it for the session
 * (see lib/quickAddBanner). Renders nothing when not permitted or hidden.
 */
export function QuickAddBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const s = useThemedStyles(makeStyles);
  const canQuickAdd = usePermission('quick_add');
  const hidden = useQuickAddBannerHidden();
  const router = useRouter();

  if (!canQuickAdd || hidden) return null;

  return (
    <TouchableOpacity
      style={[s.btn, style]}
      activeOpacity={0.85}
      onPress={() => { track('action', 'hub_quick_add', { screen: 'hub' }); router.push('/(app)/(quickadd)'); }}
    >
      <Text style={s.icon}>⚡</Text>
      <View style={s.textWrap}>
        <Text style={s.label}>Quick Add</Text>
        <Text style={s.sub}>Add items, stock & equipment fast</Text>
      </View>
      {/* Bottom-right X hides the banner for the session. */}
      <TouchableOpacity
        style={s.x}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        onPress={hideQuickAddBanner}
      >
        <Text style={s.xText}>✕</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  btn: {
    backgroundColor: t.colors.primary,
    borderRadius: t.radii.lg,
    paddingVertical: t.spacing.xl,
    paddingHorizontal: t.spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.spacing.md,
    minHeight: 72,
  },
  icon: { fontSize: 26 },
  textWrap: { flex: 1 },
  label: { color: t.colors.onPrimary, fontWeight: '800', fontSize: t.typography.fontSizes.lg },
  sub: { color: t.colors.primaryBg, fontSize: t.typography.fontSizes.body2, marginTop: 2 },
  x: {
    position: 'absolute',
    bottom: 6,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  xText: { color: t.colors.onPrimary, fontSize: 12, fontWeight: '700', lineHeight: 14 },
});
