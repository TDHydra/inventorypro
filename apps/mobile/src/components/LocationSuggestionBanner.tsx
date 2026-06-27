import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme';

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

const s = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primaryBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primaryBgStrong,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  text: { flex: 1, fontSize: 13, color: colors.primaryText, lineHeight: 18 },
  bold: { fontWeight: '700' },
  btn: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexShrink: 0,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
