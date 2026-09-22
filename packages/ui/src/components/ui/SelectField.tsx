import { useMemo, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { Field } from './Field';
import { AppInput } from './AppInput';
import { ModalSheet } from './ModalSheet';
import { loadRecentPicks, saveRecentPick } from './recentPicksStore';

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
  disabled?: boolean;                // read-only: trigger inert + muted
  // #222: opt-in for high-frequency fields — persists the last 3 picked ids
  // per key (device-local app_settings) and shows them as a Recent section.
  recentKey?: string;
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
  required, hint, error, searchable, onClear, disabled, recentKey,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Snapshot on open (not reactive) so the Recent row doesn't reshuffle
  // under the finger when a pick writes back.
  const [recentIds, setRecentIds] = useState<string[]>([]);

  const isSearchable = searchable ?? options.length > 12;
  const selected = useMemo(() => options.find(o => o.id === value) ?? null, [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!isSearchable || !q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query, isSearchable]);

  const recentOptions = useMemo(() => {
    if (!recentKey || query.trim()) return [];
    return recentIds
      .map(id => options.find(o => o.id === id))
      .filter((o): o is SelectOption => !!o);
  }, [recentKey, recentIds, options, query]);

  function openSheet() {
    setQuery('');
    if (recentKey) setRecentIds(loadRecentPicks(recentKey));
    setOpen(true);
  }
  function pick(id: string) {
    if (recentKey) saveRecentPick(recentKey, id);
    onSelect(id);
    setOpen(false);
  }
  function clear() {
    if (disabled) return;
    onClear?.();
    setOpen(false);
  }

  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <Pressable
        style={[s.trigger, disabled && s.triggerDisabled]}
        onPress={openSheet}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected ? selected.label : placeholder}`}
        accessibilityState={{ disabled: !!disabled }}
      >
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
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        {!!onClear && !disabled && (
          <Pressable style={s.row} onPress={clear}>
            <Text style={s.clearLabel}>Clear</Text>
          </Pressable>
        )}
        {recentOptions.length > 0 && (
          <>
            <Text style={s.sectionLabel}>Recent</Text>
            {recentOptions.map(opt => (
              <Pressable
                key={`recent-${opt.id}`}
                style={s.row}
                onPress={() => pick(opt.id)}
                accessibilityRole="button"
                accessibilityLabel={`Recent: ${opt.label}`}
              >
                <View style={s.rowText}>
                  <Text style={[s.rowLabel, opt.id === value && s.rowLabelSelected]}>{opt.label}</Text>
                  {!!opt.sublabel && <Text style={s.rowSub}>{opt.sublabel}</Text>}
                </View>
                {opt.id === value && <Text style={s.check}>✓</Text>}
              </Pressable>
            ))}
            <Text style={s.sectionLabel}>All</Text>
          </>
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
  triggerDisabled: { opacity: 0.45 },
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
  sectionLabel: {
    fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: t.spacing.sm, marginBottom: t.spacing.xs,
  },
  empty: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted, paddingVertical: t.spacing.base, textAlign: 'center' },
});
