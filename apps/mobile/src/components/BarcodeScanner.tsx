import { useState, useRef } from 'react';
import { View, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';

interface Props {
  active: boolean;
  onScanned: (data: string) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 1500;

export function BarcodeScanner({ active, onScanned, onClose }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const lastScanTime = useRef<number>(0);
  const lastCode = useRef<string>('');

  if (!active) return null;

  if (!permission?.granted) {
    return (
      <View style={styles.permBox}>
        <Text style={styles.permText}>Camera access is needed for barcode scanning.</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Allow Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnSecondary} onPress={onClose}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleBarcode = (result: BarcodeScanningResult) => {
    const now = Date.now();
    if (result.data === lastCode.current && now - lastScanTime.current < DEBOUNCE_MS) return;
    lastScanTime.current = now;
    lastCode.current = result.data;
    onScanned(result.data);
  };

  return (
    <View style={styles.container}>
      <CameraView
        style={styles.camera}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['ean13', 'ean8', 'code128', 'code39', 'upc_a', 'qr'],
        }}
        onBarcodeScanned={handleBarcode}
      />

      {/* Viewfinder overlay */}
      <View style={styles.overlay}>
        <View style={styles.topOverlay} />
        <View style={styles.middleRow}>
          <View style={styles.sideOverlay} />
          <View style={styles.viewfinder}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={styles.sideOverlay} />
        </View>
        <View style={styles.bottomOverlay}>
          <Text style={styles.hint}>Point camera at barcode</Text>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const CORNER = 20;
const CORNER_THICKNESS = 3;

const styles = StyleSheet.create({
  container: { flex: 1, position: 'relative' },
  camera: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill },
  topOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  middleRow: { flexDirection: 'row', height: 200 },
  sideOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  viewfinder: { width: 250, height: 200, position: 'relative' },
  bottomOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center', gap: 16,
  },
  hint: { color: '#fff', fontSize: 14 },
  corner: {
    position: 'absolute', width: CORNER, height: CORNER,
    borderColor: '#2563EB',
  },
  cornerTL: { top: 0, left: 0, borderTopWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS },
  cornerTR: { top: 0, right: 0, borderTopWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS },
  closeBtn: {
    backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 8,
    paddingHorizontal: 24, paddingVertical: 10,
  },
  closeBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  permBox: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 32, gap: 16, backgroundColor: '#F8FAFF',
  },
  permText: { fontSize: 16, color: '#475569', textAlign: 'center', lineHeight: 24 },
  btn: { backgroundColor: '#2563EB', borderRadius: 10, paddingHorizontal: 24, paddingVertical: 12 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnSecondary: { paddingVertical: 10 },
  btnSecondaryText: { color: '#64748B', fontSize: 15 },
});
