import { useState, useMemo, Ref } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import type { StyleProp, TextInput, TextInputProps, TextStyle } from 'react-native';
import { AppInput } from './ui/AppInput';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { appendSegment, lastSegment, listHas } from './ui/multiValueText';

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
  /**
   * #289: offer a `+ Create "X"` row under the suggestions when what's typed
   * isn't one of them — the shelf/vehicle quick-create affordance, lifted from
   * SearchablePicker so a free-text field can ALSO put the value somewhere
   * durable (e.g. add a part to the catalog). The typed text is committed to
   * the field either way; `onCreate` is the caller's side-write, so a failed
   * create still leaves the user's text intact.
   *
   * Omit it and no row appears — a plain free-text column needs no create step,
   * the typed value already IS the new entry.
   */
  onCreate?: (text: string) => void;
  /**
   * #289: how a picked suggestion lands in `value`.
   * - `replace` (default): the picked value becomes the field. For a single
   *   value — supplier, model, a note.
   * - `list`: the field is a comma-separated LIST (repairs.parts_needed), so the
   *   trailing segment is the query and a pick APPENDS instead of clobbering the
   *   parts already chosen. The dropdown also stays open, because the whole
   *   point is adding several in a row, and values already in the list are
   *   filtered out. Callers MUST `normalizeList` before saving (see
   *   ui/multiValueText.ts).
   */
  pickMode?: 'replace' | 'list';
  /** Passed through for long-form fields (notes). */
  multiline?: boolean;
  /** Passed through to the input (e.g. the house `multiline` height style). */
  style?: StyleProp<TextStyle>;
  /**
   * #289: false = read-only. The dropdown is suppressed too, not just the
   * typing — a suggestion row on a field you can't edit is a dead tap that
   * would silently discard the pick.
   */
  editable?: boolean;
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
 *
 * `pickMode="list"` turns the same control into a multi-value field, and
 * `onCreate` adds SearchablePicker's `+ Create "X"` row — together that's the
 * repair "Parts needed" field (#289) without a second component.
 */
export function SuggestInput({
  label, value, onChange, placeholder, suggestions,
  autoCapitalize = 'words', maxSuggestions = 8, onPick, onCreate,
  pickMode = 'replace', multiline, style, editable = true,
  autoFocus, onSubmitEditing, returnKeyType, inputRef,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const listMode = pickMode === 'list';

  // In list mode only the TRAILING segment is what the user is typing — the
  // parts already chosen sit in front of it and must not narrow the search.
  const query = listMode ? lastSegment(value) : value.trim();

  const matches = useMemo(() => {
    const q = query.toLowerCase();
    const pool = suggestions.filter(sug => {
      if (sug.toLowerCase() === q) return false; // hide exact match
      // Already chosen → nothing to add. (Replace mode has no "chosen" set.)
      return !listMode || !listHas(value, sug);
    });
    if (!q) return pool.slice(0, maxSuggestions);
    return pool.filter(sug => sug.toLowerCase().includes(q)).slice(0, maxSuggestions);
    // `value` is a dep on top of `query` because list mode also excludes the
    // segments already chosen, which live in the part of `value` before `query`.
  }, [query, value, listMode, suggestions, maxSuggestions]);

  // Nothing to create when the typed text already exists as a suggestion or is
  // already in the list — same `!exact` rule as SearchablePicker's create row.
  const showCreate = !!onCreate
    && editable
    && query.length > 0
    && !suggestions.some(sug => sug.toLowerCase() === query.toLowerCase())
    && !(listMode && listHas(value, query));

  const open = editable && focused && (matches.length > 0 || showCreate);

  function commit(text: string, created: boolean) {
    onChange(listMode ? appendSegment(value, text) : text);
    if (created) onCreate?.(text);
    else onPick?.(text);
    // List mode stays open on purpose: adding several parts in a row is the
    // whole reason it exists. Replace mode is done after one pick.
    if (!listMode) setFocused(false);
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
        multiline={multiline}
        style={style}
        editable={editable}
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
            <TouchableOpacity key={sug} style={s.row} onPress={() => commit(sug, false)}>
              <Text style={s.rowLabel}>{sug}</Text>
            </TouchableOpacity>
          ))}
          {showCreate && (
            <TouchableOpacity
              style={[s.row, s.createRow]}
              onPress={() => commit(query, true)}
              accessibilityRole="button"
              accessibilityLabel={`Create ${query}`}
            >
              <Text style={s.createText}>+ Create "{query}"</Text>
            </TouchableOpacity>
          )}
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
  // Same treatment as SearchablePicker's create row so the affordance reads
  // identically wherever the crew meets it.
  createRow: { backgroundColor: t.colors.primaryBg },
  createText: { fontSize: t.typography.fontSizes.body, color: t.colors.primaryText, fontWeight: '600' },
});
