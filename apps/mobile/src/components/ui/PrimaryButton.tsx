import { TouchableOpacity, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, radii, fontSizes } from '../../theme';

interface Props { label: string; onPress: () => void; disabled?: boolean; loading?: boolean; tone?: 'primary' | 'danger'; style?: object; }
export function PrimaryButton({ label, onPress, disabled, loading, tone = 'primary', style }: Props) {
  const bg = tone === 'danger' ? colors.danger : colors.primary;
  return (
    <TouchableOpacity
      style={[s.btn, { backgroundColor: bg }, (disabled || loading) && s.disabled, style]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
    >
      {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.text}>{label}</Text>}
    </TouchableOpacity>
  );
}
const s = StyleSheet.create({
  btn: { paddingVertical: 13, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  disabled: { opacity: 0.5 },
  text: { color: '#fff', fontWeight: '700', fontSize: fontSizes.base },
});
