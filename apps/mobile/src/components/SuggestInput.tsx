import { useState, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

interface Props {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Existing values to suggest (e.g. distinct suppliers already in the catalog). */
  suggestions: string[];
  autoCapitalize?: 'none' | 'words' | 'characters';
  maxSuggestions?: number;
}

/**
 * Free-text input that surfaces matching existing values as tappable chips —
 * nudges crews to reuse the same supplier/model spelling instead of inventing
 * a new variant each time, without locking them out of new values.
 */
export function SuggestInput({
  label, value, onChange, placeholder, suggestions,
  autoCapitalize = 'words', maxSuggestions = 6,
}: Props) {
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const pool = suggestions.filter(sug => sug.toLowerCase() !== q); // hide exact match
    if (!q) return pool.slice(0, maxSuggestions);
    return pool.filter(sug => sug.toLowerCase().includes(q)).slice(0, maxSuggestions);
  }, [value, suggestions, maxSuggestions]);

  const showChips = focused && matches.length > 0;

  return (
    <View style={s.wrap}>
      {!!label && <Text style={s.label}>{label}</Text>}
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor="#94A3B8"
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        onFocus={() => setFocused(true)}
        // Delay so a chip tap registers before the list hides.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
      />
      {showChips && (
        <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
          {matches.map(sug => (
            <TouchableOpacity key={sug} style={s.chip} onPress={() => onChange(sug)}>
              <Text style={s.chipText}>{sug}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B',
  },
  chipRow: { gap: 8, paddingVertical: 2 },
  chip: { backgroundColor: '#EEF2FF', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: '#E0E7FF' },
  chipText: { color: '#4338CA', fontSize: 13, fontWeight: '600' },
});
