/**
 * SearchHeader — debounced search input for list screens, with an optional
 * filter-chip row and result count. Standardizes the search-bar pattern used
 * (with slight variations) by `(inventory)/index`, `DashboardSearch`, and
 * `hub/SearchFlap`.
 *
 * The parent owns the debounced `value`/`onChange` pair — `onChange` fires at
 * most once every `debounceMs` while typing, immediately on clear (✕), and is
 * kept in sync if the parent resets `value` externally (e.g. a "Clear
 * filters" action elsewhere on the screen).
 *
 * Usage:
 * ```tsx
 * const [q, setQ] = useState('');
 * <SearchHeader
 *   value={q}
 *   onChange={setQ}
 *   placeholder="Search items…"
 *   chips={<FilterChip label="Low stock" active={lowStock} onPress={toggleLowStock} />}
 *   resultCount={filtered.length}
 * />
 * ```
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { AppInput } from './AppInput';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  value: string;
  onChange: (q: string) => void;
  placeholder?: string;
  debounceMs?: number;
  chips?: React.ReactNode;
  resultCount?: number;
  autoFocus?: boolean;
}

const hit = { top: 8, bottom: 8, left: 8, right: 8 };

export function SearchHeader({ value, onChange, placeholder = 'Search…', debounceMs = 250, chips, resultCount, autoFocus }: Props) {
  const s = useThemedStyles(makeStyles);
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep local echo in sync when the parent resets `value` externally.
  // Also cancel any pending debounce so stale typed text can't resurrect
  // the query right after a caller-initiated clear.
  useEffect(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setText(value);
  }, [value]);

  useEffect(() => {
    return () => {
      if (timer.current != null) clearTimeout(timer.current);
    };
  }, []);

  function handleChangeText(next: string) {
    setText(next);
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(next);
    }, debounceMs);
  }

  function handleClear() {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setText('');
    onChange('');
  }

  return (
    <View style={s.wrap}>
      <AppInput
        value={text}
        onChangeText={handleChangeText}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        right={text.length > 0 ? (
          <TouchableOpacity onPress={handleClear} hitSlop={hit} accessibilityLabel="Clear search">
            <Text style={s.clear}>✕</Text>
          </TouchableOpacity>
        ) : undefined}
      />
      {chips != null && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipsRow}>
          {chips}
        </ScrollView>
      )}
      {resultCount != null && (
        <Text style={s.count}>{resultCount} result{resultCount === 1 ? '' : 's'}</Text>
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { gap: t.spacing.sm },
  clear: { fontSize: t.typography.fontSizes.md, color: t.colors.textMuted },
  chipsRow: { flexDirection: 'row', gap: t.spacing.sm },
  count: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted, textAlign: 'right' },
});
