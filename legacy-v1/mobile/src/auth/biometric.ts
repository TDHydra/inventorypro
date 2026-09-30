import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Biometric (Face/Fingerprint) gate for returning users. This never verifies a
 * PIN — it only confirms the person holding the device, then unlocks the
 * device-held refresh token so the session can resume. No auth secret beyond
 * that revocable token ever lives on the device.
 */

export async function isBiometricAvailable(): Promise<boolean> {
  const [hasHardware, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hasHardware && enrolled;
}

export async function promptBiometric(
  reason = 'Unlock InventoryPro'
): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Sign in with PIN',
      // Allow the device passcode/pattern as a fallback when no biometric is
      // enrolled, so a device-secured phone still unlocks without a PIN re-check.
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}
