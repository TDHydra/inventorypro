import { useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { AppInput } from './ui/AppInput';
import type { Theme } from '../themes/types';
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
      {/* No close-on-blur: the old 150ms blur timeout raced row taps in
          Modal-hosted sheets — a tap that Android spent on dismissing the
          keyboard also blurred the input, so the dropdown vanished before the
          user could re-tap ("tap won't select", vehicle edit/fuel-up sheets).
          The dropdown is inline (occupies layout, no overlay), so it simply
          stays until a row/create tap closes it — those set focused=false. */}
      <AppInput
        placeholder={placeholder}
        value={query}
        onChangeText={setQuery}
        onFocus={() => setFocused(true)}
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
  dropdown: { maxHeight: 240, backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border, marginTop: 4 },
  row: { paddingHorizontal: t.spacing.base, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail },
  rowLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  rowSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 1 },
  createRow: { backgroundColor: t.colors.primaryBg },
  createText: { fontSize: t.typography.fontSizes.body, color: t.colors.primaryText, fontWeight: '600' },
  selected: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.colors.background, borderRadius: t.radii.md, paddingHorizontal: t.spacing.base, height: 44 },
  selectedLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '600' },
  selectedSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary, marginTop: 1 },
  change: { color: t.colors.primary, fontSize: t.typography.fontSizes.body2, fontWeight: '600' },
});
