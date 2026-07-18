import { useState, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';

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
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim();
    if (searchFn) return searchFn(q).slice(0, 12);
    const ql = q.toLowerCase();
    // No query yet → show an alphabetized slice so the user can browse what
    // already exists.
    if (!ql) return [...options].sort((a, b) => a.label.localeCompare(b.label)).slice(0, 8);
    // Rank matches so the CLOSEST existing options surface first (and aren't lost
    // to the 8-row cap): exact → prefix → a delimited segment starting with the
    // query (e.g. "A1" → "WH-A1") → substring → sublabel. Ties break by shorter
    // label, then alphabetically.
    const rank = (o: PickerOption): number => {
      const l = o.label.toLowerCase();
      if (l === ql) return 0;
      if (l.startsWith(ql)) return 1;
      if (l.split(/[^a-z0-9]+/i).some(seg => seg.startsWith(ql))) return 2;
      if (l.includes(ql)) return 3;
      if ((o.sublabel?.toLowerCase() ?? '').includes(ql)) return 4;
      return 99;
    };
    return options
      .map(o => ({ o, r: rank(o) }))
      .filter(x => x.r < 99)
      .sort((a, b) => a.r - b.r || a.o.label.length - b.o.label.length || a.o.label.localeCompare(b.o.label))
      .slice(0, 8)
      .map(x => x.o);
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
        placeholderTextColor={t.colors.textMuted}
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

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { position: 'relative' },
  input: { backgroundColor: t.colors.surface, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border, paddingHorizontal: 14, height: 44, fontSize: 14, color: t.colors.textPrimary },
  dropdown: { maxHeight: 240, backgroundColor: t.colors.surface, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border, marginTop: 4 },
  row: { paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  rowLabel: { fontSize: 14, color: t.colors.textPrimary },
  rowSub: { fontSize: 12, color: t.colors.textMuted, marginTop: 1 },
  createRow: { backgroundColor: t.colors.primaryBg },
  createText: { fontSize: 14, color: t.colors.primaryText, fontWeight: '600' },
  selected: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.colors.surfaceAlt, borderRadius: 10, paddingHorizontal: 14, height: 44 },
  selectedLabel: { fontSize: 14, color: t.colors.textPrimary, fontWeight: '600' },
  selectedSub: { fontSize: 12, color: t.colors.textSecondary, marginTop: 1 },
  change: { color: t.colors.primary, fontSize: 13, fontWeight: '600' },
});
