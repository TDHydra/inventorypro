import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter } from 'expo-router';
import { BarcodeScanner } from '../../../src/components/BarcodeScanner';
import { USBScanner } from '../../../src/components/USBScanner';
import { getItemByBarcode, getItemById } from '../../../src/db/queries/items';
import { getUnitByTag } from '../../../src/db/queries/equipmentUnits';
import { resolveScan } from '../../../src/scan/resolveScan';
import { verifyWithConfig } from '../../../src/scan/qrSignConfig';
import { TooltipHint } from '../../../src/components/TooltipHint';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

type ScanMode = 'camera' | 'usb';

export default function ScanScreen() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const [mode, setMode] = useState<ScanMode>('camera');

  const handleScanned = (code: string) => {
    // Verify the QR signature first — a tampered/forged INV code (or an unsigned
    // one when signatures are enforced) is rejected outright rather than resolved.
    const canonical = verifyWithConfig(code);
    if (canonical === null) {
      Alert.alert('Unverified code', 'This code couldn’t be verified — it may be damaged, forged, or not an InventoryPro label.');
      return;
    }
    const resolved = resolveScan(canonical);

    if (resolved === null) {
      // Malformed INV: token — ignore silently (camera will re-activate)
      return;
    }

    if (resolved.kind === 'item') {
      const item = getItemById(resolved.id);
      if (item) {
        if (item.kind === 'equipment') {
          router.replace({ pathname: '/(app)/(equipment)/[id]', params: { id: item.id } });
        } else {
          router.replace({ pathname: '/(app)/(checkout)', params: { itemId: item.id } });
        }
      } else {
        Alert.alert('Item Not Found', `Item "${resolved.id}" was not found in the catalog.`, [
          { text: 'OK' },
        ]);
      }
    } else if (resolved.kind === 'unit') {
      const unit = getUnitByTag(resolved.assetTag);
      if (unit) {
        const model = getItemById(unit.item_id);
        if (model && model.kind === 'equipment') {
          router.replace({ pathname: '/(app)/(equipment)/[id]', params: { id: unit.item_id } });
        } else {
          router.replace({ pathname: '/(app)/(inventory)/[id]', params: { id: unit.item_id } });
        }
      } else {
        Alert.alert('Unit Not Found', `Asset tag "${resolved.assetTag}" was not found.`, [
          { text: 'OK' },
        ]);
      }
    } else if (resolved.kind === 'location') {
      // Scanned a shelf/location QR — jump to that location's detail screen.
      router.replace({ pathname: '/(app)/(locations)/[id]', params: { id: resolved.id } });
    } else {
      // kind === 'barcode' — existing path, keeps "not found → add" prompt
      const item = getItemByBarcode(resolved.code);
      if (item) {
        router.replace({ pathname: '/(app)/(checkout)', params: { itemId: item.id } });
      } else {
        Alert.alert(
          'Item Not Found',
          `Barcode "${resolved.code}" is not in the catalog.`,
          [
            { text: 'Try Again' },
            {
              text: 'Add to Catalog',
              onPress: () =>
                router.push({ pathname: '/(app)/(inventory)/add', params: { barcode: resolved.code } }),
            },
          ]
        );
      }
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Scan Barcode', headerShown: true }} />
      <View style={s.container}>
        {/* Mode toggle */}
        <View style={s.modeBar}>
          <TouchableOpacity
            style={[s.modeBtn, mode === 'camera' && s.modeBtnActive]}
            onPress={() => setMode('camera')}
          >
            <Text style={[s.modeBtnText, mode === 'camera' && s.modeBtnTextActive]}>
              📷 Camera
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.modeBtn, mode === 'usb' && s.modeBtnActive]}
            onPress={() => setMode('usb')}
          >
            <Text style={[s.modeBtnText, mode === 'usb' && s.modeBtnTextActive]}>
              ⌨ USB Scanner
            </Text>
          </TouchableOpacity>
        </View>

        <TooltipHint screenKey="scan" />

        {mode === 'camera' ? (
          <BarcodeScanner
            active={true}
            onScanned={handleScanned}
            onClose={() => router.back()}
          />
        ) : (
          <View style={s.usbMode}>
            <USBScanner active={true} onScanned={handleScanned} />
            <Text style={s.usbIcon}>⌨</Text>
            <Text style={s.usbTitle}>USB Scanner Ready</Text>
            <Text style={s.usbHint}>
              Scan a barcode with your USB scanner. The input is captured automatically.
            </Text>
            <TouchableOpacity style={s.backBtn} onPress={() => router.back()}>
              <Text style={s.backBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
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
  modeBtnActive: { backgroundColor: t.colors.primary },
  modeBtnText: { color: t.colors.textMuted, fontSize: 14, fontWeight: '600' },
  modeBtnTextActive: { color: t.colors.onPrimary },
  usbMode: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.background, gap: 12, padding: 32,
  },
  usbIcon: { fontSize: 60 },
  usbTitle: { fontSize: 22, fontWeight: '700', color: t.colors.brand },
  usbHint: { fontSize: 14, color: t.colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  backBtn: {
    marginTop: 16, backgroundColor: t.colors.surfaceAlt, borderRadius: 10,
    paddingHorizontal: 32, paddingVertical: 12,
  },
  backBtnText: { color: '#475569', fontSize: 16, fontWeight: '600' },
});
