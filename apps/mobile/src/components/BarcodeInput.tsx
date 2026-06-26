import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { BarcodeScanner } from './BarcodeScanner';

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
  const [scanning, setScanning] = useState(false);

  return (
    <View style={s.wrap}>
      {!!label && <Text style={s.label}>{label}</Text>}
      <View style={s.row}>
        <TextInput
          style={s.input}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder ?? 'Barcode'}
          placeholderTextColor="#94A3B8"
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
          onScanned={(code) => { onChange(code); setScanning(false); }}
          onClose={() => setScanning(false)}
        />
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: 6 },
  label: { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B',
  },
  scanBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#EFF6FF', borderRadius: 10, borderWidth: 1, borderColor: '#BFDBFE',
    paddingHorizontal: 14, height: 44,
  },
  scanIcon: { fontSize: 16 },
  scanText: { color: '#1D4ED8', fontWeight: '700', fontSize: 14 },
  note: { fontSize: 12, marginTop: 2 },
  noteWarn: { color: '#B45309' },
  noteInfo: { color: '#64748B' },
});
