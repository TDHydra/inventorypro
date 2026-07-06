import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../../src/theme';
import { PINPad } from '../../src/components/PINPad';
import { getAllActiveUsers, markUserPinSet, roleColor, getRoleColorMap } from '../../src/db/queries/users';
import { useSession } from '../../src/hooks/useSession';
import { verifyPinOnline, validatePinFormat, setPinFirstTime } from '../../src/auth/pin';
import { saveSession } from '../../src/auth/session';
import { finishLogin } from '../../src/auth/finishLogin';
import { fetchRoster, RosterUser } from '../../src/auth/roster';

type Screen = 'pick' | 'pin' | 'setpin';
type SetStep = 'enter' | 'confirm';

export default function LoginScreen() {
  const router = useRouter();
  const { setUser } = useSession();

  const [screen, setScreen] = useState<Screen>('pick');
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<RosterUser | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    const local = getAllActiveUsers();
    if (local.length > 0) {
      setUsers(local);
      setNeedsFullSync(false);
      setRosterLoading(false);
      return;
    }
    // Empty local DB → new device. Pull the public roster to populate the picker.
    fetchRoster()
      .then(r => { setUsers(r); setNeedsFullSync(true); })
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

  function selectUser(user: RosterUser) {
    setSelectedUser(user);
    setPin('');
    setFirstPin('');
    setEnrollmentCode('');
    setPinError(null);
    if (user.pin_set === 0) {
      // Brand-new account — set & confirm a PIN before first sign-in.
      setSetStep('enter');
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

  // First-login: collect the enrollment code, then the PIN + confirmation, then set it server-side.
  async function submitSetPin(pinValue: string) {
    if (!selectedUser) return;

    const codeError = validatePinFormat(enrollmentCode, 6);
    if (codeError) {
      setPinError('Enter the 6-digit enrollment code your admin gave you.');
      setFirstPin('');
      setPin('');
      setSetStep('enter');
      return;
    }

    setLoading(true);
    setPinError(null);
    try {
      const result = await setPinFirstTime(selectedUser.id, pinValue, enrollmentCode);
      await saveSession(result.jwt, result.refreshToken, result.userId);
      markUserPinSet(selectedUser.id, pinValue.length);
      proceedAfterAuth(result.userId);
    } catch (err) {
      // Network or server error — restart the setup so they re-enter cleanly.
      setPinError((err as Error).message || 'Could not set your PIN. Check your connection.');
      setFirstPin('');
      setPin('');
      setSetStep('enter');
    } finally {
      setLoading(false);
    }
  }

  const handleSetPinChange = (newPin: string) => {
    setPin(newPin);
    setPinError(null);
    if (!selectedUser || newPin.length !== selectedUser.pin_length_required) return;

    if (setStep === 'enter') {
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
        <TouchableOpacity style={styles.back} onPress={() => setScreen('pick')}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <View style={styles.firstBanner}>
          <Text style={styles.firstBannerText}>👋 First sign-in — set up your PIN</Text>
        </View>

        <Text style={styles.greeting}>Welcome,</Text>
        <Text style={[styles.userName, { color: roleColor(selectedUser.role, roleColors) }]}>{selectedUser.name}</Text>

        {setStep === 'enter' && (
          <View style={styles.enrollSection}>
            <Text style={styles.pinLabel}>Enrollment code</Text>
            <Text style={styles.pinSub}>Enter the 6-digit code your admin gave you.</Text>
            <TextInput
              style={styles.enrollInput}
              placeholder="000000"
              placeholderTextColor={colors.textMuted}
              value={enrollmentCode}
              onChangeText={v => setEnrollmentCode(v.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              maxLength={6}
            />
          </View>
        )}

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

        {loading && <Text style={styles.loading}>Setting up…</Text>}
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
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={u => u.id}
        style={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.userRow} onPress={() => selectUser(item)}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.userInfo}>
              <Text style={[styles.userName2, { color: roleColor(item.role, roleColors) }]}>{item.name}</Text>
              <Text style={styles.userRole}>{item.role.replace(/_/g, ' ')}</Text>
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
  loading: { marginTop: 20, color: colors.textSecondary },
  firstBanner: { backgroundColor: colors.primaryBg, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 20, alignSelf: 'flex-start' },
  firstBannerText: { color: colors.primaryText, fontSize: 13, fontWeight: '700' },
});
