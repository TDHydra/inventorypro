import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { BarcodeScanner } from '../../../src/components/BarcodeScanner';
import { USBScanner } from '../../../src/components/USBScanner';
import { getItemByBarcode } from '../../../src/db/queries/items';

type ScanMode = 'camera' | 'usb';

export default function ScanScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<ScanMode>('camera');

  const handleScanned = (code: string) => {
    const item = getItemByBarcode(code);
    if (item) {
      router.replace({ pathname: '/(app)/(checkout)', params: { itemId: item.id } });
    } else {
      Alert.alert(
        'Item Not Found',
        `Barcode "${code}" is not in the catalog.`,
        [
          { text: 'Try Again' },
          {
            text: 'Add to Catalog',
            onPress: () => router.push({ pathname: '/(app)/(inventory)/add', params: { barcode: code } }),
          },
        ]
      );
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Scan Barcode', headerShown: true }} />
      <View style={styles.container}>
        {/* Mode toggle */}
        <View style={styles.modeBar}>
          <TouchableOpacity
            style={[styles.modeBtn, mode === 'camera' && styles.modeBtnActive]}
            onPress={() => setMode('camera')}
          >
            <Text style={[styles.modeBtnText, mode === 'camera' && styles.modeBtnTextActive]}>
              📷 Camera
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeBtn, mode === 'usb' && styles.modeBtnActive]}
            onPress={() => setMode('usb')}
          >
            <Text style={[styles.modeBtnText, mode === 'usb' && styles.modeBtnTextActive]}>
              ⌨ USB Scanner
            </Text>
          </TouchableOpacity>
        </View>

        {mode === 'camera' ? (
          <BarcodeScanner
            active={true}
            onScanned={handleScanned}
            onClose={() => router.back()}
          />
        ) : (
          <View style={styles.usbMode}>
            <USBScanner active={true} onScanned={handleScanned} />
            <Text style={styles.usbIcon}>⌨</Text>
            <Text style={styles.usbTitle}>USB Scanner Ready</Text>
            <Text style={styles.usbHint}>
              Scan a barcode with your USB scanner. The input is captured automatically.
            </Text>
            <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
              <Text style={styles.backBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  modeBar: {
    flexDirection: 'row',
    backgroundColor: '#1E293B',
    padding: 8,
    gap: 8,
  },
  modeBtn: {
    flex: 1, paddingVertical: 8, borderRadius: 8,
    alignItems: 'center',
  },
  modeBtnActive: { backgroundColor: '#2563EB' },
  modeBtnText: { color: '#94A3B8', fontSize: 14, fontWeight: '600' },
  modeBtnTextActive: { color: '#fff' },
  usbMode: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#F8FAFF', gap: 12, padding: 32,
  },
  usbIcon: { fontSize: 60 },
  usbTitle: { fontSize: 22, fontWeight: '700', color: '#1E3A5F' },
  usbHint: { fontSize: 14, color: '#64748B', textAlign: 'center', lineHeight: 22 },
  backBtn: {
    marginTop: 16, backgroundColor: '#F1F5F9', borderRadius: 10,
    paddingHorizontal: 32, paddingVertical: 12,
  },
  backBtnText: { color: '#475569', fontSize: 16, fontWeight: '600' },
});
