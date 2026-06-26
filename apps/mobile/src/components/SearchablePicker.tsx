import { useState, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

export interface PickerOption { id: string; label: string; sublabel?: string }

interface Props {
  placeholder?: string;
  options: PickerOption[];
  value: PickerOption | null;
  onSelect: (opt: PickerOption) => void;
  onCreate?: (text: string) => void;
  autoFocus?: boolean;
}

// Live-filtering entity dropdown: type to narrow existing rows to a tappable list,
// collapse to the single match, and (when onCreate is given) offer to create a new
// one when nothing matches. Used for item/location/job/PM selection so the behavior
// is identical everywhere.
export function SearchablePicker({ placeholder, options, value, onSelect, onCreate, autoFocus }: Props) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 8);
    return options.filter(o =>
      o.label.toLowerCase().includes(q) || (o.sublabel?.toLowerCase().includes(q) ?? false)
    ).slice(0, 8);
  }, [query, options]);

  const exact = useMemo(
    () => options.find(o => o.label.trim().toLowerCase() === query.trim().toLowerCase()) ?? null,
    [query, options]
  );
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
        placeholderTextColor="#94A3B8"
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
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B' },
  dropdown: { maxHeight: 240, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', marginTop: 4 },
  row: { paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  rowLabel: { fontSize: 14, color: '#1E293B' },
  rowSub: { fontSize: 12, color: '#94A3B8', marginTop: 1 },
  createRow: { backgroundColor: '#EFF6FF' },
  createText: { fontSize: 14, color: '#1D4ED8', fontWeight: '600' },
  selected: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', borderRadius: 10, paddingHorizontal: 14, height: 44 },
  selectedLabel: { fontSize: 14, color: '#1E293B', fontWeight: '600' },
  selectedSub: { fontSize: 12, color: '#64748B', marginTop: 1 },
  change: { color: '#2563EB', fontSize: 13, fontWeight: '600' },
});
