import { View, Text, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { useDbQuery } from '../hooks/useDbQuery';
import {
  getQrSignConfig, generateQrSecret, setQrSigningSecret, rotateQrSigningKey,
  clearPrevQrKey, clearQrSigning, setRequireSignedQr,
} from '../scan/qrSignConfig';

/**
 * Admin control for QR label signing (Settings → System). Signing adds a
 * tamper-evidence HMAC to printed INV: codes so forged/damaged labels are
 * rejected on scan. Enabling / rotating writes the org key to app_config
 * (syncs to every device). Grace mode (unsigned still scans) until "Require
 * signed" is turned on. Assumes it's rendered inside an admin-gated block.
 */
export function QrSigningSection() {
  const s = useThemedStyles(makeStyles);
  // Re-runs whenever a local write OR a background sync pull touches app_config
  // (#60/#63) — every admin action below writes app_config via appendOutbox,
  // whose own table bump (../sync/outbox.ts) already drives this read, so no
  // hand-rolled version counter is needed.
  const cfg = useDbQuery(() => getQrSignConfig(), [], ['app_config']);
  const enabled = !!cfg.secret;
  const rotating = !!cfg.prevSecret; // a previous key is still accepted

  function enable() {
    setQrSigningSecret(generateQrSecret());
    Alert.alert('Signing enabled', 'New labels will be signed. Existing labels still scan (grace mode) until you require signatures.');
  }
  function rotate() {
    Alert.alert('Rotate signing key?', 'A fresh key is generated for new labels. Labels printed with the current key KEEP verifying during the changeover — reprint them, then tap “Finish rotation”.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Rotate', onPress: () => rotateQrSigningKey() },
    ]);
  }
  function finishRotation() {
    Alert.alert('Finish rotation?', 'The previous key is dropped — any label still using the OLD key will no longer verify. Only do this once everything has been reprinted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Finish', style: 'destructive', onPress: () => clearPrevQrKey() },
    ]);
  }
  function turnOff() {
    Alert.alert('Turn off signing?', 'New labels will be unsigned. Enforcement is also cleared.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn off', style: 'destructive', onPress: () => { clearQrSigning(); setRequireSignedQr(false); } },
    ]);
  }
  function toggleRequire(on: boolean) {
    if (on) {
      Alert.alert('Require signed labels?', 'Unsigned/legacy labels will be REJECTED on scan. Only turn this on once everything has been reprinted with signing enabled.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Require', style: 'destructive', onPress: () => setRequireSignedQr(true) },
      ]);
    } else {
      setRequireSignedQr(false);
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
              <View style={{ flex: 1 }}>
                <Text style={s.rowLabel}>🔄 Rotate signing key</Text>
                {rotating && <Text style={s.rowSub}>Rotation in progress — old-key labels still verify.</Text>}
              </View>
            </TouchableOpacity>
            {rotating && (
              <>
                <View style={s.divider} />
                <TouchableOpacity style={s.row} onPress={finishRotation}>
                  <Text style={[s.rowLabel, s.danger]}>Finish rotation (drop old key)</Text>
                </TouchableOpacity>
              </>
            )}
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

const makeStyles = (t: Theme) => StyleSheet.create({
  sectionTitle: { fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: t.spacing.lg, marginBottom: t.spacing.sm, marginLeft: t.spacing.xs },
  card: { backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.base, gap: t.spacing.sm },
  rowLabel: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  rowSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary, marginTop: 2 },
  danger: { color: t.colors.danger },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.colors.border, marginLeft: t.spacing.base },
  primaryBtn: { margin: t.spacing.base, marginTop: 0, alignItems: 'center', paddingVertical: 12, borderRadius: t.radii.md, backgroundColor: t.colors.primary },
  primaryBtnText: { color: t.colors.onPrimary, fontWeight: '800' },
});
