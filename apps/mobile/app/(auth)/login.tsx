import { useState, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../../src/theme';
import { PINPad } from '../../src/components/PINPad';
import { getAllActiveUsers, markUserPinSet, User } from '../../src/db/queries/users';
import { useSession } from '../../src/hooks/useSession';
import { verifyPinOnline, validatePinFormat, setPinFirstTime } from '../../src/auth/pin';
import { saveSession, buildUserSession } from '../../src/auth/session';
import { appendLog } from '../../src/db/queries/log';

type Screen = 'pick' | 'pin' | 'setpin';
type SetStep = 'enter' | 'confirm';

export default function LoginScreen() {
  const router = useRouter();
  const { setUser } = useSession();

  const [screen, setScreen] = useState<Screen>('pick');
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // First-login PIN setup (enter → confirm)
  const [setStep, setSetStep] = useState<SetStep>('enter');
  const [firstPin, setFirstPin] = useState('');

  const allUsers = useMemo(() => getAllActiveUsers(), []);
  const filtered = useMemo(() => {
    if (!search.trim()) return allUsers;
    const q = search.toLowerCase();
    return allUsers.filter(u => u.name.toLowerCase().includes(q));
  }, [search, allUsers]);

  function selectUser(user: User) {
    setSelectedUser(user);
    setPin('');
    setFirstPin('');
    setPinError(null);
    if (user.pin_set === 0) {
      // Brand-new account — set & confirm a PIN before first sign-in.
      setSetStep('enter');
      setScreen('setpin');
    } else {
      setScreen('pin');
    }
  }

  // Build the session, write the login log, and navigate into the app.
  function enterApp(userId: string) {
    const session = buildUserSession(userId);
    if (!session) { setPinError('User not found on this device'); setPin(''); return; }

    appendLog({
      user_id: session.id,
      team_id: null,
      action: 'login',
      entity_type: 'user',
      entity_id: session.id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: null,
      metadata: null,
      device_id: null,
    });

    setUser(session);
    router.replace('/(app)/(dashboard)');
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
      enterApp(result.userId);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Incorrect') || msg.includes('expired') || msg.includes('inactive')) {
        // Definitive server rejection — wrong PIN or disabled account.
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

  // First-login: collect the PIN, then a confirmation entry, then set it server-side.
  async function submitSetPin(pinValue: string) {
    if (!selectedUser) return;
    setLoading(true);
    setPinError(null);
    try {
      const result = await setPinFirstTime(selectedUser.id, pinValue);
      await saveSession(result.jwt, result.refreshToken, result.userId);
      markUserPinSet(selectedUser.id, pinValue.length);
      enterApp(result.userId);
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
        <Text style={styles.userName}>{selectedUser.name}</Text>

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
        <Text style={styles.userName}>{selectedUser.name}</Text>

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
              <Text style={styles.userName2}>{item.name}</Text>
              <Text style={styles.userRole}>{item.role.replace(/_/g, ' ')}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <Text style={styles.empty}>No users found. Contact your admin.</Text>
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
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: 40, fontSize: 15 },
  // PIN screen
  back: { marginBottom: 32 },
  backText: { fontSize: 16, color: colors.primaryText },
  greeting: { fontSize: 16, color: colors.textSecondary },
  userName: { fontSize: 28, fontWeight: '700', color: colors.brand, marginBottom: 40 },
  pinSection: { alignItems: 'center', width: '100%' },
  pinLabel: { fontSize: 18, fontWeight: '600', color: colors.textPrimary, marginBottom: 6 },
  pinSub: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: 22, paddingHorizontal: 24 },
  loading: { marginTop: 20, color: colors.textSecondary },
  firstBanner: { backgroundColor: colors.primaryBg, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 20, alignSelf: 'flex-start' },
  firstBannerText: { color: colors.primaryText, fontSize: 13, fontWeight: '700' },
});
