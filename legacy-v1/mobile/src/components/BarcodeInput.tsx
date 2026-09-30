import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { BarcodeScanner } from './BarcodeScanner';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { sanitizeScan } from '../scan/sanitize';

interface Props {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Optional note shown under the field (e.g. duplicate-barcode warning). */
  note?: string;
  noteTone?: 'warn' | 'info';
}

/** Barcode text field with an inline "Scan" button that opens the camera. */
export function BarcodeInput({ label, value, onChange, placeholder, note, noteTone = 'info' }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const [scanning, setScanning] = useState(false);

  // Bound/clean every value before it flows out — a wedge HID scanner types
  // straight into this field, so typed input is just as attacker-influenceable
  // as a camera scan. Allow an explicit clear (empty) through; drop over-length
  // / control-char junk rather than emitting it downstream.
  const handleChange = (text: string) => {
    if (text === '') { onChange(''); return; }
    const cleaned = sanitizeScan(text);
    if (cleaned !== null) onChange(cleaned);
  };

  return (
    <View style={s.wrap}>
      {!!label && <Text style={s.label}>{label}</Text>}
      <View style={s.row}>
        <TextInput
          style={s.input}
          value={value}
          onChangeText={handleChange}
          placeholder={placeholder ?? 'Barcode'}
          placeholderTextColor={t.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={s.scanBtn} onPress={() => setScanning(true)} accessibilityLabel="Scan barcode">
          <Text style={s.scanIcon}>📷</Text>
          <Text style={s.scanText}>Scan</Text>
        </TouchableOpacity>
      </View>
      {!!note && (
        <Text style={[s.note, noteTone === 'warn' ? s.noteWarn : s.noteInfo]}>{note}</Text>
      )}

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <BarcodeScanner
          active={scanning}
          onScanned={(code) => {
            // BarcodeScanner already sanitizes, but re-check defensively before
            // emitting; ignore an unusable scan (keep the scanner open).
            const clean = sanitizeScan(code);
            if (!clean) return;
            onChange(clean);
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      </Modal>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontSize: 12, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1, backgroundColor: t.colors.inputBg, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: 14, height: 44, fontSize: 14, color: t.colors.textPrimary,
  },
  scanBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: t.colors.primaryBg, borderRadius: 10, borderWidth: 1, borderColor: t.colors.primaryBgStrong,
    paddingHorizontal: 14, height: 44,
  },
  scanIcon: { fontSize: 16 },
  scanText: { color: t.colors.primaryText, fontWeight: '700', fontSize: 14 },
  note: { fontSize: 12, marginTop: 2 },
  noteWarn: { color: '#B45309' },
  noteInfo: { color: t.colors.textSecondary },
});
