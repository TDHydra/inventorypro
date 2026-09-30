import { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { SearchablePicker, PickerOption } from '../SearchablePicker';
import { PrimaryButton } from '../ui/PrimaryButton';
import { ModalSheet } from '../ui/ModalSheet';
import { confirmSheet } from '../ui/ConfirmSheet';

// Generic add/remove people-list editor (#126) — the teams-roster idiom
// ((teams)/[id].tsx add-member sheet + remove-with-confirm rows) generalized
// into a reusable ModalSheet. The caller owns ALL persistence: `onAdd`/
// `onRemove` do the writes (and may be async / may throw — failures alert here
// and leave the sheet open), and the caller refreshes `entries` afterwards.
// First consumer: locker access grants (LockerPanel); crews reuse it later.

/** One person currently on the list. */
export interface AccessEntry {
  userId: string;
  name: string;
  sublabel?: string | null;
  /** Locked rows render without a Remove control (e.g. the owner). */
  fixed?: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** People already on the list. */
  entries: AccessEntry[];
  /** People who could be added (caller excludes current entries). */
  candidates: PickerOption[];
  /** false = read-only view (no picker, no remove buttons). */
  canEdit: boolean;
  onAdd: (option: PickerOption) => void | Promise<void>;
  onRemove: (entry: AccessEntry) => void | Promise<void>;
  /** Confirm copy for removal; defaults to access wording. */
  removeNoun?: string;
}

export function AccessListEditor({
  visible, onClose, title, entries, candidates, canEdit, onAdd, onRemove,
  removeNoun = 'access',
}: Props) {
  const s = useThemedStyles(makeStyles);
  const [selected, setSelected] = useState<PickerOption | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleAdd() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await onAdd(selected);
      // Clear only after the caller's write committed; sheet stays open so
      // several people can be added in one sitting.
      setSelected(null);
    } catch {
      Alert.alert('Could not add', `${selected.label} was not added. Please try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(entry: AccessEntry) {
    if (busy) return;
    const ok = await confirmSheet({
      title: 'Remove',
      message: `Remove ${entry.name}'s ${removeNoun}?`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await onRemove(entry);
    } catch {
      Alert.alert('Could not remove', `${entry.name} was not removed. Please try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll={false}>
      <Text style={s.title}>{title}</Text>
      {/* flexShrink:1 lets this ScrollView shrink within ModalSheet's maxHeight cap so it actually scrolls (RN defaults flexShrink:0). */}
      <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>

        {entries.length === 0 ? (
          <Text style={s.muted}>Nobody here yet{canEdit ? ' — add someone below.' : '.'}</Text>
        ) : (
          <View style={s.list}>
            {entries.map((e, i) => (
              <View key={e.userId} style={[s.row, i < entries.length - 1 && s.divider]}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{e.name}</Text>
                  {e.sublabel ? <Text style={s.sublabel}>{e.sublabel}</Text> : null}
                </View>
                {canEdit && !e.fixed && (
                  <TouchableOpacity
                    onPress={() => handleRemove(e)}
                    disabled={busy}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={[s.removeBtn, busy && s.disabled]}
                  >
                    <Text style={s.removeText}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </View>
        )}

        {canEdit && (
          candidates.length === 0 ? (
            <Text style={s.muted}>Everyone has already been added.</Text>
          ) : (
            <>
              <SearchablePicker
                placeholder="Search people…"
                options={candidates}
                value={selected}
                onSelect={(opt) => setSelected(prev => (prev?.id === opt.id ? null : opt))}
              />
              <PrimaryButton
                label={busy ? 'Adding…' : 'Add'}
                onPress={handleAdd}
                disabled={!selected || busy}
              />
            </>
          )
        )}

        <TouchableOpacity style={s.closeRow} onPress={onClose}>
          <Text style={s.closeText}>{canEdit ? 'Done' : 'Close'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 14 },
  muted: { fontSize: 14, color: t.colors.textMuted },
  list: {
    borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radii.md,
    paddingHorizontal: t.spacing.base,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  name: { fontSize: 15, color: t.colors.textPrimary, fontWeight: '600' },
  sublabel: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  removeBtn: { marginLeft: 12 },
  removeText: { color: t.colors.danger, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  closeRow: { paddingVertical: 10, alignItems: 'center', marginBottom: 4 },
  closeText: { color: t.colors.textMuted, fontSize: 15, fontWeight: '600' },
});
