import { useState, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { colors } from '../theme';

export interface PickerOption { id: string; label: string; sublabel?: string }

interface Props {
  placeholder?: string;
  options?: PickerOption[];
  value: PickerOption | null;
  onSelect: (opt: PickerOption) => void;
  onCreate?: (text: string) => void;
  autoFocus?: boolean;
  // When provided, the dropdown is sourced by querying on each keystroke instead
  // of filtering a static `options` array client-side. Required for large sets
  // (e.g. the full item catalog) where a capped pre-load would hide most rows.
  searchFn?: (query: string) => PickerOption[];
}

// Live-filtering entity dropdown: type to narrow existing rows to a tappable list,
// collapse to the single match, and (when onCreate is given) offer to create a new
// one when nothing matches. Used for item/location/job/PM selection so the behavior
// is identical everywhere. For large catalogs pass `searchFn` (DB-backed) instead
// of a static `options` array.
export function SearchablePicker({ placeholder, options = [], value, onSelect, onCreate, autoFocus, searchFn }: Props) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim();
    if (searchFn) return searchFn(q).slice(0, 12);
    const ql = q.toLowerCase();
    if (!ql) return options.slice(0, 8);
    return options.filter(o =>
      o.label.toLowerCase().includes(ql) || (o.sublabel?.toLowerCase().includes(ql) ?? false)
    ).slice(0, 8);
  }, [query, options, searchFn]);

  const exact = useMemo(() => {
    const ql = query.trim().toLowerCase();
    if (!ql) return null;
    // For searchFn mode, the live results already reflect the query, so an exact
    // label match (used to suppress the "+ Create" row) will be among them.
    const pool = searchFn ? matches : options;
    return pool.find(o => o.label.trim().toLowerCase() === ql) ?? null;
  }, [query, options, searchFn, matches]);
  const showCreate = !!onCreate && query.trim().length > 0 && !exact;
  const open = focused && (matches.length > 0 || showCreate);

  if (value) {
    return (
      <TouchableOpacity style={s.selected} onPress={() => { onSelect(value); setQuery(''); }}>
        <View style={{ flex: 1 }}>
          <Text style={s.selectedLabel}>{value.label}</Text>
          {!!value.sublabel && <Text style={s.selectedSub}>{value.sublabel}</Text>}
        </View>
        <Text style={s.change}>Change</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={s.wrap}>
      <TextInput
        style={s.input}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        value={query}
        onChangeText={setQuery}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        autoFocus={autoFocus}
      />
      {open && (
        <ScrollView style={s.dropdown} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {matches.map(o => (
            <TouchableOpacity key={o.id} style={s.row} onPress={() => { onSelect(o); setQuery(''); setFocused(false); }}>
              <Text style={s.rowLabel}>{o.label}</Text>
              {!!o.sublabel && <Text style={s.rowSub}>{o.sublabel}</Text>}
            </TouchableOpacity>
          ))}
          {showCreate && (
            <TouchableOpacity style={[s.row, s.createRow]} onPress={() => { onCreate!(query.trim()); setFocused(false); }}>
              <Text style={s.createText}>+ Create "{query.trim()}"</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { position: 'relative' },
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, height: 44, fontSize: 14, color: colors.textPrimary },
  dropdown: { maxHeight: 240, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginTop: 4 },
  row: { paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  rowLabel: { fontSize: 14, color: colors.textPrimary },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  createRow: { backgroundColor: colors.primaryBg },
  createText: { fontSize: 14, color: colors.primaryText, fontWeight: '600' },
  selected: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 14, height: 44 },
  selectedLabel: { fontSize: 14, color: colors.textPrimary, fontWeight: '600' },
  selectedSub: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  change: { color: colors.primary, fontSize: 13, fontWeight: '600' },
});
