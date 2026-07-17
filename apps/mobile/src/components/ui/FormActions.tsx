import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { PrimaryButton } from './PrimaryButton';
import { colors } from '../../theme';

interface Props {
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  disabled?: boolean;
}

/**
 * The Cancel + Save button row every edit form hand-rolls, extracted once.
 * Styles are copied verbatim from (jobs)/[id].tsx (s.row / s.btnGhost) so a
 * swap is visually identical. Pure — no persistence, no alerts.
 */
export function FormActions({ onCancel, onSave, saveLabel = 'Save', cancelLabel = 'Cancel', busy, disabled }: Props) {
  return (
    <View style={s.row}>
      <TouchableOpacity style={[s.btnGhost, { flex: 1 }]} onPress={onCancel} disabled={busy}>
        <Text style={s.btnGhostText}>{cancelLabel}</Text>
      </TouchableOpacity>
      <PrimaryButton label={saveLabel} onPress={onSave} loading={busy} disabled={disabled} style={{ flex: 1 }} />
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btnGhost: {
    borderRadius: 12, paddingVertical: 13, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.textDisabled,
  },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
});
