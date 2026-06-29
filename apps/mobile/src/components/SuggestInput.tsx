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
  /**
   * Fired only when the user explicitly taps an existing value in the dropdown
   * (not on every keystroke). Lets callers trigger cross-fill on a real pick
   * while leaving free typing untouched. `onChange` still fires with the value.
   */
  onPick?: (v: string) => void;
}

/**
 * Free-text input with a filter-as-you-type dropdown of existing values. Type to
 * narrow the list of prior values, tap one to fill it, or just keep typing a new
 * value (for free-text columns, the typed value IS the new entry — no separate
 * create step). Nudges crews to reuse the same supplier/model/customer spelling
 * without locking them out of new values. Mirrors SearchablePicker's dropdown look.
 */
export function SuggestInput({
  label, value, onChange, placeholder, suggestions,
  autoCapitalize = 'words', maxSuggestions = 8, onPick,
}: Props) {
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const pool = suggestions.filter(sug => sug.toLowerCase() !== q); // hide exact match
    if (!q) return pool.slice(0, maxSuggestions);
    return pool.filter(sug => sug.toLowerCase().includes(q)).slice(0, maxSuggestions);
  }, [value, suggestions, maxSuggestions]);

  const open = focused && matches.length > 0;

  function pick(sug: string) {
    onChange(sug);
    onPick?.(sug);
    setFocused(false);
  }

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
        // Delay so a row tap registers before the list hides.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
      />
      {open && (
        <ScrollView style={s.dropdown} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {matches.map(sug => (
            <TouchableOpacity key={sug} style={s.row} onPress={() => pick(sug)}>
              <Text style={s.rowLabel}>{sug}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: 6, position: 'relative' },
  label: { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B',
  },
  dropdown: { maxHeight: 240, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', marginTop: 2 },
  row: { paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  rowLabel: { fontSize: 14, color: '#1E293B' },
});
