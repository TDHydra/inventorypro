import { useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, Animated, StyleSheet } from 'react-native';
import { colors } from '../../theme';

interface Props {
  value: string;
  onChangeText: (t: string) => void;
  open: boolean;
  onToggle: () => void;
}

// A collapsible search bar. Collapsed: a thin "Search ▾" handle. Open: a full
// search input + "▴" to collapse. Height animates so it conserves space.
export function SearchFlap({ value, onChangeText, open, onToggle }: Props) {
  const h = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(h, { toValue: open ? 1 : 0, duration: 200, useNativeDriver: false }).start();
  }, [open, h]);
  const height = h.interpolate({ inputRange: [0, 1], outputRange: [0, 52] });

  return (
    <View style={s.wrap}>
      <TouchableOpacity style={s.handle} onPress={onToggle} activeOpacity={0.7}>
        <Text style={s.handleText}>🔍 Search</Text>
        <Text style={s.handleArrow}>{open ? '▴' : '▾'}</Text>
      </TouchableOpacity>
      <Animated.View style={[s.barWrap, { height }]}>
        <View style={s.searchBox}>
          <TextInput
            style={s.input}
            placeholder="Search items, equipment, jobs, locations, people…"
            placeholderTextColor={colors.textMuted}
            value={value}
            onChangeText={onChangeText}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
          />
        </View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: colors.background },
  handle: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 8,
  },
  handleText: { fontSize: 14, fontWeight: '700', color: colors.textSecondary },
  handleArrow: { fontSize: 14, color: colors.textSecondary },
  barWrap: { overflow: 'hidden', justifyContent: 'center', paddingHorizontal: 12 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12,
  },
  input: { flex: 1, height: 42, fontSize: 15, color: colors.textPrimary },
});
