import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../../src/theme';
import { PINPad } from '../../src/components/PINPad';
import { getAllActiveUsers, markUserPinSet, roleColor, getRoleColorMap, getRoleSettings } from '../../src/db/queries/users';
import { useSession } from '../../src/hooks/useSession';
import { verifyPinOnline, validatePinFormat, setPinFirstTime, isWeakPin } from '../../src/auth/pin';
import { saveSession } from '../../src/auth/session';
import { finishLogin } from '../../src/auth/finishLogin';
import { fetchRoster, RosterUser } from '../../src/auth/roster';
import { getPendingCount } from '../../src/sync/outbox';
import { pushPendingLogs } from '../../src/sync/engine';
import { prepareForDemoLogin } from '../../src/sync/demoHandoff';
import { getAppConfig } from '../../src/db/appConfig';
import { Alert } from '../../src/lib/themedAlert';

type Screen = 'pick' | 'pin' | 'setpin';
// First-login runs as three sequential steps, one screen each: enrollment code,
// then choose a PIN, then confirm it.
type SetStep = 'code' | 'enter' | 'confirm';

export default function LoginScreen() {
  const router = useRouter();
  const { setUser } = useSession();

  const [screen, setScreen] = useState<Screen>('pick');
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<RosterUser | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Demo pick with pending work does a network push before it can proceed —
  // block the picker meanwhile so a second tap can't race it.
  const [switching, setSwitching] = useState(false);

  // First-login PIN setup (enter → confirm)
  const [setStep, setSetStep] = useState<SetStep>('enter');
  const [firstPin, setFirstPin] = useState('');
  const [enrollmentCode, setEnrollmentCode] = useState('');

  // Sign-in roster. Returning devices read it from the local DB (offline-capable);
  // a brand-new device (empty local DB) fetches the minimal public /auth/roster.
  // `needsFullSync` is true only in the latter case — that device has no business
  // data yet, so after PIN sign-in we route it through the post-login download.
  const [users, setUsers] = useState<RosterUser[]>([]);
  const [needsFullSync, setNeedsFullSync] = useState(false);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const loadRoster = useCallback(() => {
    setRosterLoading(true);
    setRosterError(null);
    // Demo kill switch (#32 S5): synced app_config.demo_mode === '0' hides
    // demo/test accounts from the picker. Missing key or '1' → show (default
    // ON, matching the server-side gate in apps/api/src/lib/demoMode.ts).
    const demoHidden = getAppConfig('demo_mode') === '0';
    const hideDemo = (rows: RosterUser[]) => (demoHidden ? rows.filter(u => !u.is_test) : rows);
    const local = getAllActiveUsers();
    if (local.length > 0) {
      // A user who hasn't set a PIN yet must be prompted for the role's MINIMUM
      // length (#88), not the placeholder stored on the row. The server roster
      // applies this too, but a synced device uses this local path — mirror it
      // via the synced role_settings map. Users who've already set a PIN keep
      // their own length so the enter-PIN screen still matches their real PIN.
      const roleMins = getRoleSettings();
      // Local rows carry the demo code as enrollment_code_public; the roster
      // endpoint calls it test_code — normalize so the picker reads one field.
      setUsers(hideDemo(local.map(u => ({
        ...u,
        pin_length_required: u.pin_set === 0
          ? Math.max(u.pin_length_required, roleMins[u.role] ?? 0)
          : u.pin_length_required,
        test_code: u.is_test ? u.enrollment_code_public ?? null : null,
      }))));
      setNeedsFullSync(false);
      setRosterLoading(false);
      return;
    }
    // Empty local DB → new device. Pull the public roster to populate the
    // picker. /auth/roster already omits demo rows when the switch is off, but
    // filter here too so a stale cached response can't resurface them.
    fetchRoster()
      .then(r => { setUsers(hideDemo(r)); setNeedsFullSync(true); })
      .catch(e => setRosterError((e as Error).message || 'Could not reach the server. Connect to the internet to set up this device.'))
      .finally(() => setRosterLoading(false));
  }, []);

  useEffect(() => { loadRoster(); }, [loadRoster]);

  const roleColors = useMemo(() => getRoleColorMap(), []);

  const filtered = useMemo(() => {
    if (!search.trim()) return users;
    const q = search.toLowerCase();
    return users.filter(u => u.name.toLowerCase().includes(q));
  }, [search, users]);

  async function selectUser(user: RosterUser) {
    // A test session wipes the whole local DB at logout, so the outgoing user's
    // un-synced work cannot come with us. It is discarded on demo entry (see
    // finishLogin) — silently, since demo edits are throwaway by definition. The
    // audit trail is the exception: push it first, with the OUTGOING user's JWT,
    // which is still current here and won't be once the demo PIN is verified.
    if (user.is_test && getPendingCount() > 0) {
      setSwitching(true);
      const { ok, stuckLogs } = await prepareForDemoLogin({
        pendingCount: getPendingCount,
        pushLogs: pushPendingLogs,
      });
      setSwitching(false);
      if (!ok) {
        Alert.alert(
          'Activity log not synced',
          `${stuckLogs} activity ${stuckLogs === 1 ? 'entry has' : 'entries have'} not reached the server yet, and a demo session would erase ${stuckLogs === 1 ? 'it' : 'them'}. Connect to the network and try again.`,
        );
        return;
      }
    }
    setSelectedUser(user);
    setPin('');
    setFirstPin('');
    setEnrollmentCode('');
    setPinError(null);
    if (user.pin_set === 0) {
      // Brand-new account — enrollment code, then set & confirm a PIN.
      setSetStep('code');
      setScreen('setpin');
    } else {
      setScreen('pin');
    }
  }

  // Finish a returning-user sign-in: build the session locally and enter the app.
  // New devices (needsFullSync) take a different path — see proceedAfterAuth.
  function enterApp(userId: string) {
    if (!finishLogin(userId, setUser)) {
      setPinError('User not found on this device');
      setPin('');
      return;
    }
    router.replace('/(app)/(dashboard)');
  }

  // Called once the server has verified the PIN and the session is saved. A
  // brand-new device has no local data yet, so it goes to the first-launch
  // screen to download the full DB (authenticated) before entering the app.
  // Returning devices already have their data and enter directly.
  function proceedAfterAuth(userId: string) {
    if (needsFullSync) {
      router.replace('/(auth)/first-launch');
      return;
    }
    enterApp(userId);
  }

  async function submitPin(pinValue: string = pin) {
    if (!selectedUser) return;

    const formatError = validatePinFormat(pinValue, selectedUser.pin_length_required);
    if (formatError) { setPinError(formatError); return; }

    setLoading(true);
    setPinError(null);

    try {
      // Online path: server verifies the PIN and returns JWT + 30-day refresh
      // token, which the sync engine uses to keep pushing/pulling.
      const result = await verifyPinOnline(selectedUser.id, pinValue);
      await saveSession(result.jwt, result.refreshToken, result.userId);
      proceedAfterAuth(result.userId);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Incorrect') || msg.includes('Invalid credentials') || msg.includes('expired') || msg.includes('inactive') || msg.includes('Too many')) {
        // Definitive server rejection — wrong PIN, disabled/expired account, or
        // rate-limited (too many attempts). Show the server's message.
        setPinError(msg);
      } else {
        // First-time sign-in requires the server (PIN is never verified on-device).
        setPinError('Connection required to sign in. Returning users can unlock with biometrics.');
      }
      setPin('');
    } finally {
      setLoading(false);
    }
  }

  // Auto-submit when PIN is fully entered
  const handlePinChange = (newPin: string) => {
    setPin(newPin);
    setPinError(null);
    if (selectedUser && newPin.length === selectedUser.pin_length_required) {
      // Small delay so user sees the last dot fill before submit.
      // Pass newPin explicitly — `pin` state is one render behind here.
      setTimeout(() => submitPin(newPin), 150);
    }
  };

  // Step 1 → 2. The code is only format-checked here; the server is the real
  // authority and rejects a wrong code at submitSetPin (401 → back to 'code').
  function submitEnrollmentCode() {
    if (validatePinFormat(enrollmentCode, 6)) {
      setPinError('Enter the 6-digit enrollment code your admin gave you.');
      return;
    }
    setPinError(null);
    setPin('');
    setFirstPin('');
    setSetStep('enter');
  }

  // Step 3: PIN entered and confirmed — set it server-side.
  async function submitSetPin(pinValue: string) {
    if (!selectedUser) return;

    setLoading(true);
    setPinError(null);
    try {
      const result = await setPinFirstTime(selectedUser.id, pinValue, enrollmentCode);
      await saveSession(result.jwt, result.refreshToken, result.userId);
      // Test accounts self-reset: the server never persists their PIN, so the
      // local pin_set must stay 0 too — otherwise the NEXT visitor on this
      // device lands on the PIN screen and dead-ends against a 409.
      if (!selectedUser.is_test) markUserPinSet(selectedUser.id, pinValue.length);
      proceedAfterAuth(result.userId);
    } catch (err) {
      const msg = (err as Error).message || 'Could not set your PIN. Check your connection.';
      setPinError(msg);
      setFirstPin('');
      setPin('');
      // A rejected code has to be re-entered on step 1 — landing on the PIN pad
      // would hide the field the user actually needs to fix.
      if (msg.includes('enrollment code')) {
        setEnrollmentCode('');
        setSetStep('code');
      } else {
        setSetStep('enter');
      }
    } finally {
      setLoading(false);
    }
  }

  // Back walks the wizard one step at a time; only step 1 leaves for the picker.
  function stepBack() {
    setPinError(null);
    setPin('');
    if (setStep === 'confirm') {
      setFirstPin('');
      setSetStep('enter');
    } else if (setStep === 'enter') {
      setFirstPin('');
      setSetStep('code');
    } else {
      setScreen('pick');
    }
  }

  const handleSetPinChange = (newPin: string) => {
    setPin(newPin);
    setPinError(null);
    if (!selectedUser || newPin.length !== selectedUser.pin_length_required) return;

    if (setStep === 'enter') {
      // Reject trivially guessable PINs before advancing — instant feedback so
      // the user isn't asked to confirm a PIN the server would reject at set-pin.
      if (isWeakPin(newPin)) {
        setPinError('That PIN is too easy to guess. Avoid repeats and sequences like 1234.');
        setTimeout(() => setPin(''), 200);
        return;
      }
      // First entry captured — advance to confirmation.
      setFirstPin(newPin);
      setTimeout(() => { setPin(''); setSetStep('confirm'); }, 200);
    } else {
      // Confirmation — must match the first entry.
      if (newPin === firstPin) {
        setTimeout(() => submitSetPin(newPin), 150);
      } else {
        setPinError("Those PINs didn't match — let's try again.");
        setFirstPin('');
        setTimeout(() => { setPin(''); setSetStep('enter'); }, 200);
      }
    }
  };

  if (screen === 'setpin' && selectedUser) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
        <TouchableOpacity style={styles.back} onPress={stepBack}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.firstBanner}>
          <Text style={styles.firstBannerText}>
            {setStep === 'code' ? '👋 First sign-in — enter your code' : '👋 First sign-in — set up your PIN'}
          </Text>
        </View>

        <Text style={styles.greeting}>Welcome,</Text>
        <Text style={[styles.userName, { color: roleColor(selectedUser.role, roleColors) }]}>{selectedUser.name}</Text>

        {setStep === 'code' ? (
          <View style={styles.enrollSection}>
            <Text style={styles.pinLabel}>Enrollment code</Text>
            <Text style={styles.pinSub}>Enter the 6-digit code your admin gave you.</Text>
            <TextInput
              style={styles.enrollInput}
              placeholder="000000"
              placeholderTextColor={colors.textMuted}
              value={enrollmentCode}
              onChangeText={v => { setEnrollmentCode(v.replace(/\D/g, '').slice(0, 6)); setPinError(null); }}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
              onSubmitEditing={submitEnrollmentCode}
              returnKeyType="next"
            />
            {pinError && <Text style={styles.enrollError}>{pinError}</Text>}
            {!!selectedUser.is_test && !!selectedUser.test_code && (
              <Text style={styles.testCode}>demo account — enter code {selectedUser.test_code}</Text>
            )}
            <TouchableOpacity
              style={[styles.continueBtn, enrollmentCode.length !== 6 && styles.continueBtnDisabled]}
              onPress={submitEnrollmentCode}
              disabled={enrollmentCode.length !== 6}
            >
              <Text style={styles.continueText}>Continue</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.pinSection}>
            <Text style={styles.pinLabel}>
              {setStep === 'enter' ? 'Create your PIN' : 'Re-enter to confirm'}
            </Text>
            <Text style={styles.pinSub}>
              {setStep === 'enter'
                ? `Choose a ${selectedUser.pin_length_required}-digit PIN you'll use to sign in.`
                : 'Enter the same PIN again so we know it’s right.'}
            </Text>
            <PINPad
              value={pin}
              onChange={handleSetPinChange}
              requiredLength={selectedUser.pin_length_required}
              error={pinError}
            />
          </View>
        )}

        {loading && <Text style={styles.loading}>Setting up…</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  if (screen === 'pin' && selectedUser) {
    return (
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity style={styles.back} onPress={() => setScreen('pick')}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.greeting}>Welcome,</Text>
        <Text style={[styles.userName, { color: roleColor(selectedUser.role, roleColors) }]}>{selectedUser.name}</Text>

        <View style={styles.pinSection}>
          <Text style={styles.pinLabel}>Enter your PIN</Text>
          <PINPad
            value={pin}
            onChange={handlePinChange}
            requiredLength={selectedUser.pin_length_required}
            error={pinError}
          />
        </View>

        {loading && <Text style={styles.loading}>Verifying...</Text>}
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.appName}>InventoryPro</Text>
      <Text style={styles.heading}>Who are you?</Text>

      <View style={styles.searchBox}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search name..."
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          // Desktop flow: land in search on load, Enter picks the top match —
          // name → Enter → PIN digits, no mouse. Native keeps the soft
          // keyboard tucked away until the user taps.
          autoFocus={Platform.OS === 'web'}
          onSubmitEditing={() => { if (filtered.length > 0 && !switching) void selectUser(filtered[0]); }}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={u => u.id}
        style={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.userRow}
            disabled={switching}
            onPress={() => { void selectUser(item); }}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.userInfo}>
              <Text style={[styles.userName2, { color: roleColor(item.role, roleColors) }]}>{item.name}</Text>
              <Text style={styles.userRole}>{item.role.replace(/_/g, ' ')}</Text>
              {!!item.is_test && !!item.test_code && (
                <Text style={styles.testCode}>demo account — code {item.test_code}</Text>
              )}
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          rosterLoading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.empty}>Loading sign-in list…</Text>
            </View>
          ) : rosterError ? (
            <View style={styles.emptyState}>
              <Text style={styles.empty}>{rosterError}</Text>
              <TouchableOpacity onPress={loadRoster} style={{ marginTop: 12 }}>
                <Text style={styles.backText}>Tap to retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={styles.empty}>No users found. Contact your admin.</Text>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  appName: { fontSize: 20, fontWeight: '700', color: colors.primaryText, marginBottom: 4 },
  heading: { fontSize: 26, fontWeight: '700', color: colors.brand, marginBottom: 16 },
  searchBox: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  searchInput: { height: 44, fontSize: 16, color: colors.textPrimary },
  list: { flex: 1 },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  avatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.primaryBg,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { fontSize: 16, fontWeight: '700', color: colors.primaryText },
  userInfo: { flex: 1 },
  userName2: { fontSize: 16, fontWeight: '600', color: colors.textPrimary },
  userRole: { fontSize: 12, color: colors.textSecondary, textTransform: 'capitalize', marginTop: 2 },
  // Deliberately quiet: the demo access code is public, but it should read as a
  // hint under the row/field ("small grayed out lettering"), not a callout.
  testCode: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  chevron: { fontSize: 20, color: colors.textDisabled },
  separator: { height: 1, backgroundColor: colors.borderDetail, marginLeft: 66 },
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: 12, fontSize: 15 },
  emptyState: { alignItems: 'center', marginTop: 40 },
  // PIN screen
  back: { marginBottom: 32 },
  backText: { fontSize: 16, color: colors.primaryText },
  greeting: { fontSize: 16, color: colors.textSecondary },
  userName: { fontSize: 28, fontWeight: '700', color: colors.brand, marginBottom: 40 },
  pinSection: { alignItems: 'center', width: '100%' },
  pinLabel: { fontSize: 18, fontWeight: '600', color: colors.textPrimary, marginBottom: 6 },
  pinSub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: 22, paddingHorizontal: 24 },
  enrollSection: { alignItems: 'center', width: '100%', marginBottom: 28 },
  enrollInput: {
    width: 160,
    textAlign: 'center',
    fontSize: 22,
    letterSpacing: 6,
    color: colors.textPrimary,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
  },
  enrollError: { marginTop: 12, fontSize: 13, color: colors.danger, textAlign: 'center' },
  continueBtn: {
    marginTop: 28,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 40,
    minWidth: 200,
    alignItems: 'center',
  },
  continueBtnDisabled: { opacity: 0.4 },
  continueText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  loading: { marginTop: 20, color: colors.textSecondary },
  firstBanner: { backgroundColor: colors.primaryBg, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 20, alignSelf: 'flex-start' },
  firstBannerText: { color: colors.primaryText, fontSize: 13, fontWeight: '700' },
});
