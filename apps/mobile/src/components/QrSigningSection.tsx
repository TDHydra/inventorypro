import { useState } from 'react';
import { View, Text, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import { colors, spacing, fontSizes, radii } from '../theme';
import {
  getQrSignConfig, generateQrSecret, setQrSigningSecret, clearQrSigning, setRequireSignedQr,
} from '../scan/qrSignConfig';

/**
 * Admin control for QR label signing (Settings → System). Signing adds a
 * tamper-evidence HMAC to printed INV: codes so forged/damaged labels are
 * rejected on scan. Enabling / rotating writes the org key to app_config
 * (syncs to every device). Grace mode (unsigned still scans) until "Require
 * signed" is turned on. Assumes it's rendered inside an admin-gated block.
 */
export function QrSigningSection() {
  const [version, setVersion] = useState(0);
  const cfg = getQrSignConfig(); // re-read each render; `version` forces refresh after writes
  const enabled = !!cfg.secret;
  const reload = () => setVersion(v => v + 1);

  function enable() {
    setQrSigningSecret(generateQrSecret());
    reload();
    Alert.alert('Signing enabled', 'New labels will be signed. Existing labels still scan (grace mode) until you require signatures.');
  }
  function rotate() {
    Alert.alert('Rotate signing key?', 'A new key is generated. Labels printed with the OLD key will no longer verify and must be reprinted (they still scan while signatures aren’t required).', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Rotate', style: 'destructive', onPress: () => { setQrSigningSecret(generateQrSecret()); reload(); } },
    ]);
  }
  function turnOff() {
    Alert.alert('Turn off signing?', 'New labels will be unsigned. Enforcement is also cleared.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: () => { clearQrSigning(); setRequireSignedQr(false); reload(); } },
    ]);
  }
  function toggleRequire(on: boolean) {
    if (on) {
      Alert.alert('Require signed labels?', 'Unsigned/legacy labels will be REJECTED on scan. Only turn this on once everything has been reprinted with signing enabled.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Require', style: 'destructive', onPress: () => { setRequireSignedQr(true); reload(); } },
      ]);
    } else {
      setRequireSignedQr(false);
      reload();
    }
  }

  return (
    <View>
      <Text style={s.sectionTitle}>QR label security</Text>
      <View style={s.card}>
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowLabel}>Signing {enabled ? 'on' : 'off'}</Text>
            <Text style={s.rowSub}>
              {enabled
                ? 'Printed QR labels carry a tamper-evidence signature; forged/damaged codes are rejected on scan.'
                : 'Add a signature to printed QR labels so forged codes can be detected on scan.'}
            </Text>
          </View>
        </View>

        {!enabled ? (
          <TouchableOpacity style={s.primaryBtn} onPress={enable}>
            <Text style={s.primaryBtnText}>Enable signing</Text>
          </TouchableOpacity>
        ) : (
          <>
            <View style={s.divider} />
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.rowLabel}>Require signed labels</Text>
                <Text style={s.rowSub}>Reject unsigned/legacy labels on scan (do this after reprinting).</Text>
              </View>
              <Switch value={cfg.requireSigned} onValueChange={toggleRequire} />
            </View>
            <View style={s.divider} />
            <TouchableOpacity style={s.row} onPress={rotate}>
              <Text style={s.rowLabel}>🔄 Rotate signing key</Text>
            </TouchableOpacity>
            <View style={s.divider} />
            <TouchableOpacity style={s.row} onPress={turnOff}>
              <Text style={[s.rowLabel, s.danger]}>Turn off signing</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  sectionTitle: { fontSize: fontSizes.caption, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: spacing.lg, marginBottom: spacing.sm, marginLeft: spacing.xs },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.base, paddingVertical: spacing.base, gap: spacing.sm },
  rowLabel: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary },
  rowSub: { fontSize: fontSizes.caption, color: colors.textSecondary, marginTop: 2 },
  danger: { color: colors.danger },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: spacing.base },
  primaryBtn: { margin: spacing.base, marginTop: 0, alignItems: 'center', paddingVertical: 12, borderRadius: radii.md, backgroundColor: colors.primary },
  primaryBtnText: { color: '#fff', fontWeight: '800' },
});
