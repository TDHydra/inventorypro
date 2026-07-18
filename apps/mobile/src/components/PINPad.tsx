import { useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';

interface Props {
  value: string;
  onChange: (pin: string) => void;
  requiredLength: number;
  error?: string | null;
}

const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

export function PINPad({ value, onChange, requiredLength, error }: Props) {
  const s = useThemedStyles(makeStyles);
  const handleKey = (key: string) => {
    if (key === '⌫') {
      onChange(value.slice(0, -1));
    } else if (key === '') {
      // empty space key
    } else if (value.length < requiredLength) {
      onChange(value + key);
    }
  };

  // Physical-keyboard entry (web): desktops drive the pad with a real keyboard.
  // Document-level so no element needs focus first; e.key is the digit for both
  // the number row and the numpad. Skipped while a real text field has focus so
  // typing in another input on the same screen can't leak into the PIN.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        handleKey(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleKey('⌫');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  });

  return (
    <View style={s.container}>
      {/* Dots */}
      <View style={s.dots}>
        {Array.from({ length: requiredLength }).map((_, i) => (
          <View
            key={i}
            style={[
              s.dot,
              i < value.length && s.dotFilled,
              error && s.dotError,
            ]}
          />
        ))}
      </View>

      {error ? (
        <Text style={s.error}>{error}</Text>
      ) : (
        <Text style={s.hint}>{requiredLength}-digit PIN</Text>
      )}

      {/* Keypad */}
      <View style={s.grid}>
        {KEYS.map((key, idx) => (
          <TouchableOpacity
            key={idx}
            style={[s.key, key === '' && s.keyEmpty]}
            onPress={() => handleKey(key)}
            disabled={key === ''}
            activeOpacity={0.6}
          >
            <Text style={[s.keyText, key === '⌫' && s.backspace]}>
              {key}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { alignItems: 'center', width: '100%' },
  dots: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: t.colors.textMuted,
    backgroundColor: 'transparent',
  },
  dotFilled: {
    backgroundColor: t.colors.primary,
    borderColor: t.colors.primary,
  },
  dotError: {
    borderColor: t.colors.danger,
    backgroundColor: t.colors.dangerBg,
  },
  hint: { fontSize: 13, color: t.colors.textMuted, marginBottom: 24 },
  error: { fontSize: 13, color: t.colors.danger, marginBottom: 24 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 240,
    gap: 12,
  },
  key: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: t.colors.borderDetail,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyEmpty: { backgroundColor: 'transparent' },
  keyText: { fontSize: 22, fontWeight: '500', color: t.colors.textPrimary },
  backspace: { fontSize: 18, color: t.colors.textSecondary },
});
