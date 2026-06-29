/**
 * Web (WebAuthn) shadow of biometric.ts. Same surface as the native module so
 * shared call sites work unchanged: a Face/Fingerprint-style gate for returning
 * users that confirms the person at the keyboard, then unlocks the device-held
 * refresh token. No auth secret beyond that revocable token lives on the device.
 *
 * On the web we use the WebAuthn platform authenticator (Touch ID / Windows
 * Hello / Android biometric) when available. When it isn't, we report the same
 * "unavailable" result the native file returns when there's no hardware, so the
 * app falls back to PIN re-entry. Nothing here throws at import time.
 */

// A platform authenticator is the WebAuthn analogue of native biometric
// hardware. If the browser has none (or the API is missing entirely), behave
// exactly like native with no enrolled biometrics: report unavailable.
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    if (
      typeof window === 'undefined' ||
      typeof window.PublicKeyCredential === 'undefined' ||
      typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !==
        'function'
    ) {
      return false;
    }
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function promptBiometric(
  // Kept for signature parity with native; WebAuthn surfaces its own prompt UI.
  reason = 'Unlock InventoryPro'
): Promise<boolean> {
  void reason;
  try {
    if (
      typeof window === 'undefined' ||
      typeof window.PublicKeyCredential === 'undefined' ||
      typeof navigator === 'undefined' ||
      !navigator.credentials ||
      typeof navigator.credentials.get !== 'function'
    ) {
      return false;
    }

    // A random challenge is sufficient: we are gating local device presence, not
    // authenticating against a server, so the assertion is never sent anywhere.
    const challenge = new Uint8Array(32);
    (window.crypto ?? globalThis.crypto).getRandomValues(challenge);

    const credential = await navigator.credentials.get({
      publicKey: {
        challenge,
        timeout: 60_000,
        // No allowCredentials → let the platform offer any enrolled discoverable
        // credential; userVerification 'required' forces the biometric/PIN prompt.
        userVerification: 'required',
      },
    });

    return credential != null;
  } catch {
    // Cancel, no enrolled credential, or any failure → fall back to PIN.
    return false;
  }
}
