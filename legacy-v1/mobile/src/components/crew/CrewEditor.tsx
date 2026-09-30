import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { EntityEditSheet } from '../ui/EntityEditSheet';
import { AppInput } from '../ui/AppInput';
import { Field } from '../ui/Field';
import { UserPicker } from '../pickers/UserPicker';
import { SearchablePicker, PickerOption } from '../SearchablePicker';
import { validateName } from '../../lib/validation';
import type { Crew } from '../../db/queries/subteams';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export interface CrewDraft {
  name: string;
  leadId: string;
  helperIds: string[];
}

// Create/edit sheet for a crew (subteam): name, one lead, one-or-more helpers
// (default field flow is lead + 1, but more helpers are allowed). Candidates
// (this team's members) come from the caller; persistence is the caller's too —
// `onSave(draft)` must throw to keep the sheet open (EntityEditSheet contract).
export function CrewEditor({
  visible,
  onClose,
  crew,
  candidates,
  onSave,
  disabled,
}: {
  visible: boolean;
  onClose: () => void;
  /** Set for edit mode; null/undefined = create. */
  crew?: Crew | null;
  /** The parent team's members — the only assignable people. */
  candidates: PickerOption[];
  onSave: (draft: CrewDraft) => void | Promise<void>;
  disabled?: boolean;
}) {
  const s = useThemedStyles(makeStyles);

  const [name, setName] = useState('');
  const [lead, setLead] = useState<PickerOption | null>(null);
  const [helpers, setHelpers] = useState<PickerOption[]>([]);

  // (Re)seed the draft each time the sheet opens — edit prefills from the crew,
  // create starts blank. Outside-tap dismiss keeps state (onClose only hides),
  // matching the other entity edit sheets.
  useEffect(() => {
    if (!visible) return;
    if (crew) {
      setName(crew.name);
      setLead(crew.lead ? { id: crew.lead.id, label: crew.lead.name } : null);
      setHelpers(crew.helpers.map(h => ({ id: h.id, label: h.name })));
    } else {
      setName('');
      setLead(null);
      setHelpers([]);
    }
    // Re-seed only on open / target change, not on candidate churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, crew?.id]);

  const candidateIds = useMemo(() => new Set(candidates.map(c => c.id)), [candidates]);
  // UserPicker snapshots its options on mount, so key it to the roster + open
  // state to re-snapshot per open (roster edits while the screen is up).
  const leadPickerKey = `${visible ? 'open' : 'closed'}:${candidates.map(c => c.id).join(',')}`;

  // Helper add: team members not already the lead or a helper.
  const helperOptions = useMemo<PickerOption[]>(() => {
    const taken = new Set<string>(helpers.map(h => h.id));
    if (lead) taken.add(lead.id);
    return candidates.filter(c => !taken.has(c.id));
  }, [candidates, helpers, lead]);

  function addHelper(opt: PickerOption) {
    setHelpers(prev => (prev.some(h => h.id === opt.id) ? prev : [...prev, opt]));
  }

  function removeHelper(id: string) {
    setHelpers(prev => prev.filter(h => h.id !== id));
  }

  // Validates, then hands the caller a clean draft. Throwing keeps the sheet
  // open (EntityEditSheet contract); the caller's onSave owns persistence
  // errors/alerts for the write itself.
  async function handleSave() {
    const trimmed = name.trim();
    const nameResult = validateName(trimmed, { label: 'Crew name' });
    if (!nameResult.ok) {
      Alert.alert('Invalid name', nameResult.error);
      throw new Error(`validation: name ${nameResult.rule}`);
    }
    if (!lead) {
      Alert.alert('Lead required', 'Pick a lead for this crew.');
      throw new Error('validation: lead required');
    }
    // Guard against a stale selection after a roster change.
    const roster = [lead.id, ...helpers.map(h => h.id)];
    if (roster.some(id => !candidateIds.has(id))) {
      Alert.alert('Not a team member', 'Someone selected is no longer on this team.');
      throw new Error('validation: non-member selected');
    }
    await onSave({
      name: trimmed,
      leadId: lead.id,
      helperIds: helpers.filter(h => h.id !== lead.id).map(h => h.id),
    });
  }

  return (
    <EntityEditSheet
      visible={visible}
      onClose={onClose}
      title={crew ? 'Edit Crew' : 'New Crew'}
      onSave={handleSave}
      saveLabel={crew ? 'Save Changes' : 'Create Crew'}
      disabled={disabled}
    >
      <View style={s.body}>
        <Field label="Crew name" required>
          <AppInput
            placeholder="e.g. TV/FT"
            value={name}
            onChangeText={setName}
            autoFocus={!crew}
          />
        </Field>

        <UserPicker
          key={leadPickerKey}
          label="Lead *"
          placeholder="Search team members…"
          value={lead}
          onChange={opt => {
            setLead(opt);
            // A member can't be lead and helper at once.
            if (opt) removeHelper(opt.id);
          }}
          filter={u => candidateIds.has(u.id)}
        />

        <Field label="Helpers">
          {helpers.map(h => (
            <View key={h.id} style={s.helperRow}>
              <Text style={s.helperName} numberOfLines={1}>{h.label}</Text>
              <TouchableOpacity
                onPress={() => removeHelper(h.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={`Remove ${h.label}`}
              >
                <Text style={s.removeText}>Remove</Text>
              </TouchableOpacity>
            </View>
          ))}
          {helperOptions.length === 0 ? (
            <Text style={s.muted}>
              {candidates.length === 0
                ? 'No team members to assign.'
                : 'Everyone on the team is already in this crew.'}
            </Text>
          ) : (
            <SearchablePicker
              placeholder="Add a helper…"
              options={helperOptions}
              value={null}
              onSelect={addHelper}
            />
          )}
        </Field>
      </View>
    </EntityEditSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  body: { gap: t.spacing.base },
  helperRow: {
    flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
    paddingVertical: t.spacing.xs,
  },
  helperName: { flex: 1, fontSize: t.typography.fontSizes.md, color: t.colors.textPrimary, fontWeight: t.typography.weights.semibold },
  removeText: { color: t.colors.danger, fontSize: t.typography.fontSizes.sm, fontWeight: t.typography.weights.semibold },
  muted: { fontSize: t.typography.fontSizes.sm, color: t.colors.textMuted },
});
