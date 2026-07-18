import { useState, useRef, useEffect } from 'react';
import {
  View, StyleSheet, Text, TouchableOpacity, Animated, Easing, StatusBar, Platform,
} from 'react-native';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { sanitizeScan } from '../scan/sanitize';

interface Props {
  active: boolean;
  onScanned: (data: string) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 1500;
const FRAME_W = 280;
const FRAME_H = 210;
const TOP_INSET = (Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 44) + 8;

export function BarcodeScanner({ active, onScanned, onClose }: Props) {
  const styles = useThemedStyles(makeStyles);
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const lastScanTime = useRef<number>(0);
  const lastCode = useRef<string>('');
  const scanLine = useRef(new Animated.Value(0)).current;

  // Sweep the scan line while the camera is live — the "alive" affordance the
  // old flat overlay lacked.
  useEffect(() => {
    if (!active || !permission?.granted) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLine, { toValue: 1, duration: 1900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(scanLine, { toValue: 0, duration: 1900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, permission?.granted, scanLine]);

  if (!active) return null;

  if (!permission?.granted) {
    return (
      <View style={styles.permBox}>
        <View style={styles.permIconWrap}>
          <Text style={styles.permIcon}>📷</Text>
        </View>
        <Text style={styles.permTitle}>Camera access</Text>
        <Text style={styles.permText}>
          InventoryPro needs the camera to scan barcodes and QR labels.
        </Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission} activeOpacity={0.85}>
          <Text style={styles.btnText}>Enable camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btnSecondary} onPress={onClose}>
          <Text style={styles.btnSecondaryText}>Not now</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const handleBarcode = (result: BarcodeScanningResult) => {
    // Bound/clean before emitting — a malicious QR or runaway scanner can carry
    // megabytes or control-char junk; sanitizeScan returns null for those.
    const code = sanitizeScan(result.data);
    if (!code) { console.warn('[BarcodeScanner] dropped invalid scan'); return; }
    const now = Date.now();
    if (code === lastCode.current && now - lastScanTime.current < DEBOUNCE_MS) return;
    lastScanTime.current = now;
    lastCode.current = code;
    onScanned(code);
  };

  const lineTranslate = scanLine.interpolate({
    inputRange: [0, 1],
    outputRange: [10, FRAME_H - 10],
  });

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{
          barcodeTypes: ['ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e', 'qr', 'datamatrix'],
        }}
        onBarcodeScanned={handleBarcode}
      />

      {/* Dim mask with a clear cut-out window */}
      <View style={styles.overlay} pointerEvents="box-none">
        <View style={styles.maskTop} />
        <View style={styles.maskMiddle}>
          <View style={styles.maskSide} />
          <View style={styles.frame}>
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
            <Animated.View style={[styles.scanLine, { transform: [{ translateY: lineTranslate }] }]} />
          </View>
          <View style={styles.maskSide} />
        </View>
        <View style={styles.maskBottom}>
          <View style={styles.hintPill}>
            <Text style={styles.hintText}>Align the barcode or QR inside the frame</Text>
          </View>
        </View>
      </View>

      {/* Top bar: close + torch */}
      <View style={[styles.topBar, { paddingTop: TOP_INSET }]} pointerEvents="box-none">
        <TouchableOpacity style={styles.iconBtn} onPress={onClose} accessibilityLabel="Close scanner" hitSlop={hit}>
          <Text style={styles.iconBtnText}>✕</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Scan</Text>
        <TouchableOpacity
          style={[styles.iconBtn, torch && styles.iconBtnActive]}
          onPress={() => setTorch(t => !t)}
          accessibilityLabel={torch ? 'Turn flashlight off' : 'Turn flashlight on'}
          hitSlop={hit}
        >
          <Text style={styles.iconBtnText}>{torch ? '🔦' : '💡'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const hit = { top: 8, bottom: 8, left: 8, right: 8 };
const CORNER = 30;
const CT = 4;
const MASK = 'rgba(0,0,0,0.55)';

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, position: 'relative', backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFill },
  maskTop: { flex: 1, backgroundColor: MASK },
  maskMiddle: { flexDirection: 'row', height: FRAME_H },
  maskSide: { flex: 1, backgroundColor: MASK },
  maskBottom: { flex: 1, backgroundColor: MASK, alignItems: 'center', paddingTop: 28 },
  frame: { width: FRAME_W, height: FRAME_H, borderRadius: 18, overflow: 'hidden' },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: t.colors.primary },
  cornerTL: { top: 0, left: 0, borderTopWidth: CT, borderLeftWidth: CT, borderTopLeftRadius: 18 },
  cornerTR: { top: 0, right: 0, borderTopWidth: CT, borderRightWidth: CT, borderTopRightRadius: 18 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: CT, borderLeftWidth: CT, borderBottomLeftRadius: 18 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: CT, borderRightWidth: CT, borderBottomRightRadius: 18 },
  scanLine: {
    position: 'absolute', left: 10, right: 10, height: 2.5, borderRadius: 2,
    backgroundColor: t.colors.accent,
    shadowColor: t.colors.accent, shadowOpacity: 0.9, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
  },
  hintPill: {
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999,
    paddingHorizontal: 18, paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.18)',
  },
  hintText: { color: '#fff', fontSize: 13.5, fontWeight: '500' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 12,
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },
  iconBtn: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)',
  },
  iconBtnActive: { backgroundColor: t.colors.accent, borderColor: t.colors.accent },
  iconBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  // Permission screen
  permBox: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 32, gap: 14, backgroundColor: t.colors.background,
  },
  permIconWrap: {
    width: 88, height: 88, borderRadius: 44, backgroundColor: t.colors.accentBg,
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  permIcon: { fontSize: 40 },
  permTitle: { fontSize: 20, fontWeight: '800', color: t.colors.textPrimary },
  permText: { fontSize: 15, color: t.colors.textSecondary, textAlign: 'center', lineHeight: 22, maxWidth: 300 },
  btn: {
    backgroundColor: t.colors.primary, borderRadius: 12,
    paddingHorizontal: 28, paddingVertical: 14, marginTop: 8, minWidth: 220, alignItems: 'center',
  },
  btnText: { color: t.colors.onPrimary, fontWeight: '800', fontSize: 16 },
  btnSecondary: { paddingVertical: 10 },
  btnSecondaryText: { color: t.colors.textSecondary, fontSize: 15, fontWeight: '600' },
});
