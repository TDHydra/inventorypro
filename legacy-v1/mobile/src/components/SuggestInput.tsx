import { useState, useMemo, Ref } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import type { TextInput, TextInputProps } from 'react-native';
import { AppInput } from './ui/AppInput';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';

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
  autoFocus?: boolean;
  /** Fired on keyboard submit; the dropdown is closed before this runs. */
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  returnKeyType?: TextInputProps['returnKeyType'];
  /** Reaches the underlying native TextInput (focus/blur). */
  inputRef?: Ref<TextInput>;
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
  autoFocus, onSubmitEditing, returnKeyType, inputRef,
}: Props) {
  const s = useThemedStyles(makeStyles);
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
      <AppInput
        ref={inputRef}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType={returnKeyType}
        onFocus={() => setFocused(true)}
        // No close-on-blur: the blur timeout raced row taps in Modal-hosted
        // sheets (see SearchablePicker) — `pick`/submit close the list instead.
        onSubmitEditing={(e) => {
          setFocused(false);
          onSubmitEditing?.(e);
        }}
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

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { gap: 6, position: 'relative' },
  label: { fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  dropdown: { maxHeight: 240, backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border, marginTop: 2 },
  row: { paddingHorizontal: t.spacing.base, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail },
  rowLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
});
