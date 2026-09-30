import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';

interface Props {
  name: string | null;
  distanceM: number | null;
  onUse: () => void;
}

/**
 * One-line proximity suggestion banner. Renders nothing when name or distanceM is
 * null (no permission / no anchored location nearby). Tapping "Use it" fires onUse
 * (caller selects the location); nothing auto-commits.
 */
export function LocationSuggestionBanner({ name, distanceM, onUse }: Props) {
  const s = useThemedStyles(makeStyles);
  if (!name || distanceM == null) return null;
  return (
    <View style={s.banner}>
      <Text style={s.text} numberOfLines={1}>
        {'You\'re at '}
        <Text style={s.bold}>{name}</Text>
        {` (~${Math.round(distanceM)} m)`}
      </Text>
      <TouchableOpacity style={s.btn} onPress={onUse}>
        <Text style={s.btnText}>Use it</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: t.colors.primaryBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.colors.primaryBgStrong,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  text: { flex: 1, fontSize: 13, color: t.colors.primaryText, lineHeight: 18 },
  bold: { fontWeight: '700' },
  btn: {
    backgroundColor: t.colors.primary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexShrink: 0,
  },
  btnText: { color: t.colors.onPrimary, fontWeight: '700', fontSize: 13 },
});
