import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  getTaxonomyTypes,
  getTaxonomyTypesWithFallback,
} from '../../db/queries/taxonomy';
import { renderIcon } from '../../constants/locationStyles';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { resolveTaxonomyValue } from './resolveTaxonomyValue';

// The app's one taxonomy input shape: the horizontal row of FilterChips
// (getTaxonomyTypes* + map → `${renderIcon(icon)} ${label}` chip + hold selection)
// that teams/index, teams/[id], JobQuickAdd and TeamQuickAdd each hand-roll.
// (A dropdown sibling, TaxonomyPicker, existed but never gained a call site and
// was deleted — board #19.)
//
// #74 is mid-migration: some screens persist the taxonomy LABEL, some the soft-FK
// id. This ALWAYS reports both via onChange and never migrates which one a call
// site persists.
//
// Returns a FRAGMENT, not a Field/View wrapper: at every call site the FieldLabel
// and the chip ScrollView are laid out by the PARENT container's gap (12 in the
// team modals, s.fieldWrap in the quickadds). Wrapping them would change that
// spacing, so they stay bare siblings the parent positions.
// There is deliberately no `defaultToFirst` prop. Seeding the first type from a
// mount effect paints one frame with nothing selected, and ModalSheet's <Modal>
// unmounts its children while hidden, so every open would flash. Call sites seed
// synchronously in their own useState initializer instead.
export function TaxonomyChips({
  category,
  valueId,
  valueLabel,
  onChange,
  label,
  withFallback,
  deselectable,
  disabled,
}: {
  category: string;
  valueId?: string | null;
  valueLabel?: string | null;
  onChange: (next: { id: string | null; label: string | null }) => void;
  label?: string;
  withFallback?: boolean;      // getTaxonomyTypesWithFallback (teams) vs getTaxonomyTypes (quickadds)
  deselectable?: boolean;      // JobQuickAdd's re-tap-clears; the other three never clear
  disabled?: boolean;
}) {
  // Options exactly as each screen sources them — strict active list, or the
  // never-empty fallback list. Both spellings appear across the four call sites.
  const types = useMemo(
    () =>
      withFallback
        ? getTaxonomyTypesWithFallback(category)
        : getTaxonomyTypes(category),
    [category, withFallback],
  );

  // Resolve the stored value (id and/or label) against the SAME list that renders
  // the chips, so an id- and a label-persisting screen (#74) light up the identical
  // chip; an archived/unknown value resolves to nothing and lights none — matching
  // today's `value === t.label` when the value isn't in the list.
  const resolved = resolveTaxonomyValue(types, valueId, valueLabel);
  function isActive(t: { id: string; label: string }): boolean {
    return resolved.id != null ? resolved.id === t.id : resolved.label === t.label;
  }

  function handlePress(t: { id: string; label: string }) {
    if (deselectable && isActive(t)) {
      onChange({ id: null, label: null });
      return;
    }
    onChange({ id: t.id, label: t.label });
  }

  // Discoverability for the horizontal overflow (board #85): the chip row often
  // runs off-screen with no cue. Compare rendered content width against the
  // visible container width; when the chips overflow, paint a subtle right-edge
  // fade so it's obvious there's more to scroll to. The wrapper below is
  // box-neutral (relative, zero padding/margin) so it doesn't disturb the
  // parent-gap spacing the four call sites depend on (see header note).
  const [containerWidth, setContainerWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const overflowing = contentWidth > containerWidth + 1;

  return (
    <>
      {!!label && <FieldLabel>{label}</FieldLabel>}
      <View
        style={s.scrollWrap}
        onLayout={e => setContainerWidth(e.nativeEvent.layout.width)}
      >
        {/* No call site disables this today; pointerEvents+opacity is additive only. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          contentContainerStyle={s.chipRow}
          pointerEvents={disabled ? 'none' : 'auto'}
          style={disabled ? s.disabled : undefined}
          onContentSizeChange={w => setContentWidth(w)}
        >
          {types.map(t => (
            <FilterChip
              key={t.label}
              label={`${renderIcon(t.icon)} ${t.label}`}
              active={isActive(t)}
              onPress={() => handlePress(t)}
            />
          ))}
        </ScrollView>
        {overflowing && (
          // Stacked translucent slabs approximate a fade toward the surface
          // colour (no expo-linear-gradient dependency in this app). Purely a
          // visual cue — never intercepts touches.
          <View pointerEvents="none" style={s.fade}>
            <View style={[s.fadeLayer, s.fadeLayer1]} />
            <View style={[s.fadeLayer, s.fadeLayer2]} />
            <View style={[s.fadeLayer, s.fadeLayer3]} />
          </View>
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  scrollWrap: { position: 'relative' },
  chipRow: { gap: 8, paddingRight: 8 },
  disabled: { opacity: 0.5 },
  fade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: 28,
    flexDirection: 'row',
  },
  fadeLayer: { height: '100%' },
  fadeLayer1: { flex: 1, backgroundColor: 'rgba(255,255,255,0.25)' },
  fadeLayer2: { flex: 1, backgroundColor: 'rgba(255,255,255,0.55)' },
  fadeLayer3: { flex: 1, backgroundColor: 'rgba(255,255,255,0.85)' },
});
