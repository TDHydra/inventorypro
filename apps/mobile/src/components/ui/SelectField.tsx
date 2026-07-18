import { useMemo, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { Field } from './Field';
import { AppInput } from './AppInput';
import { ModalSheet } from './ModalSheet';

export interface SelectOption { id: string; label: string; sublabel?: string }

interface Props {
  label: string;
  value: string | null;              // option id
  options: SelectOption[];
  onSelect: (id: string) => void;
  placeholder?: string;              // default 'Select…'
  required?: boolean; hint?: string; error?: string;
  searchable?: boolean;              // default: options.length > 12
  onClear?: () => void;              // when provided, sheet shows a Clear row
}

/**
 * Labeled select for FIXED option sets (units, roles, taxonomy labels,
 * statuses) — tap the field → bottom sheet of options → pick. Not for
 * large/DB-searched sets (items, locations, jobs, …) — those stay on
 * `SearchablePicker` / `src/components/pickers/*`.
 *
 * Usage:
 *   <SelectField
 *     label="Unit" required
 *     value={unitId}
 *     options={UNITS.map(u => ({ id: u, label: u }))}
 *     onSelect={setUnitId}
 *   />
 */
export function SelectField({
  label, value, options, onSelect, placeholder = 'Select…',
  required, hint, error, searchable, onClear,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const isSearchable = searchable ?? options.length > 12;
  const selected = useMemo(() => options.find(o => o.id === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!isSearchable || !q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query, isSearchable]);

  function openSheet() {
    setQuery('');
    setOpen(true);
  }
  function pick(id: string) {
    onSelect(id);
    setOpen(false);
  }
  function clear() {
    onClear?.();
    setOpen(false);
  }

  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <Pressable style={s.trigger} onPress={openSheet}>
        <Text style={selected ? s.value : s.placeholder} numberOfLines={1}>
          {selected ? selected.label : placeholder}
        </Text>
        <Text style={s.chevron}>▾</Text>
      </Pressable>

      <ModalSheet visible={open} onClose={() => setOpen(false)} scroll>
        <Text style={s.header}>{label}</Text>
        {isSearchable && (
          <AppInput
            style={s.search}
            placeholder="Search…"
            value={query}
            onChangeText={setQuery}
            autoFocus
          />
        )}
        {!!onClear && (
          <Pressable style={s.row} onPress={clear}>
            <Text style={s.clearLabel}>Clear</Text>
          </Pressable>
        )}
        {filtered.map(opt => {
          const isSelected = opt.id === value;
          return (
            <Pressable key={opt.id} style={s.row} onPress={() => pick(opt.id)}>
              <View style={s.rowText}>
                <Text style={[s.rowLabel, isSelected && s.rowLabelSelected]}>{opt.label}</Text>
                {!!opt.sublabel && <Text style={s.rowSub}>{opt.sublabel}</Text>}
              </View>
              {isSelected && <Text style={s.check}>✓</Text>}
            </Pressable>
          );
        })}
        {filtered.length === 0 && <Text style={s.empty}>No matches</Text>}
      </ModalSheet>
    </Field>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  trigger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, height: 44,
  },
  value: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, flexShrink: 1 },
  placeholder: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted, flexShrink: 1 },
  chevron: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted, marginLeft: t.spacing.sm },
  header: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.md },
  search: { marginBottom: t.spacing.sm },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: t.spacing.base, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail,
  },
  rowText: { flex: 1 },
  rowLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  rowLabelSelected: { fontWeight: '600' },
  rowSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 1 },
  check: { fontSize: t.typography.fontSizes.body, color: t.colors.primary, fontWeight: '700', marginLeft: t.spacing.sm },
  clearLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, fontStyle: 'italic' },
  empty: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted, paddingVertical: t.spacing.base, textAlign: 'center' },
});
