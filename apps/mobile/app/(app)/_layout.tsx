import { useEffect, useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../src/hooks/useSession';
import { SyncIndicator } from '../../src/components/SyncIndicator';
import { NotificationBell } from '../../src/components/NotificationBell';
import { ChatBell } from '../../src/components/ChatBell';
import { QuickPhotoFlow, openQuickPhoto } from '../../src/components/quickphoto/QuickPhotoFlow';
import { useIdleLogout } from '../../src/hooks/useIdleLogout';
import { useIdleReauth } from '../../src/hooks/useIdleReauth';
import { usePermission } from '../../src/hooks/usePermission';
import { setMaintenanceRole } from '../../src/db/maintenance';
import { useMaintenanceMode } from '../../src/hooks/useMaintenanceMode';
import { appAlertBus, IDLE_NUDGE_TAG } from '../../src/lib/alertBus';
import { PreviewBanner } from '../../src/components/ui/PreviewBanner';
import { OfflineBanner } from '../../src/components/ui/OfflineBanner';
import { useDbQuery } from '../../src/hooks/useDbQuery';
import { getOnboardingChecklist } from '../../src/db/userPrefs';
import { getRoleIdleReauthMinutes } from '../../src/db/queries/users';
import { OnboardingChecklistSheet } from '../../src/components/profile/OnboardingChecklistSheet';
import { ReauthGate } from '../../src/components/ReauthGate';
import { useReauthRequired } from '../../src/auth/reauthGate';
import { markReauthed } from '../../src/auth/reauthTracker';
import type { Theme } from '../../src/themes/types';
import { useTheme } from '../../src/hooks/useTheme';
import { useThemedStyles } from '../../src/hooks/useThemedStyles';

export default function AppLayout() {
  const { user, realUser, logout } = useSession();
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);

  // Idle auto-logout — must be called before any early return (React rules)
  const idle = useIdleLogout(
    async () => {
      appAlertBus.dismissActive(IDLE_NUDGE_TAG); // don't leave the nudge over the login screen
      await logout();
    },
    {
      onWarn: showIdleNudge,
      // Test/demo sessions are pinned to a 15-minute idle logout even when the
      // admin setting disables idle logout entirely.
      overrideMinutes: user?.is_test ? 15 : undefined,
    },
  );
  const reset = idle.reset;
  // Nudge everybody a minute before the idle logout. The dialog renders in its
  // own native window, so its button press never reaches the touch interceptor
  // below — the cancel-style button resets explicitly (backdrop taps and
  // Android back also route through the cancel button).
  function showIdleNudge() {
    appAlertBus.alert({
      tag: IDLE_NUDGE_TAG,
      title: 'Still there?',
      message: "You'll be signed out in a minute due to inactivity.",
      buttons: [{ text: "I'm still here", style: 'cancel', onPress: () => idle.reset() }],
    });
  }
  const maint = useMaintenanceMode();
  // #169: hide the header quick-photo button for users who can't upload —
  // without the gate they walk the whole capture flow and fail at presign.
  const canUploadMedia = usePermission('upload_media');

  // #244: per-role idle re-auth. Keyed off realUser (never the effective/
  // previewed user — a preview-as-role session must never inherit a looser or
  // tighter threshold than the real signed-in identity, same convention as the
  // maintenance-role effect below). Demo/test sessions are exempt (no real
  // security stake, mirrors the is_test carve-out already used elsewhere in
  // this file) — resolved to 0 (disabled), which useIdleReauth/checkReauthDue
  // both already treat as a no-op.
  const idleReauthMinutes = useDbQuery(
    () => (realUser && !realUser.is_test ? getRoleIdleReauthMinutes()[realUser.role] ?? 0 : 0),
    [realUser?.id, realUser?.role, realUser?.is_test],
    ['role_settings'],
  );
  const reauth = useIdleReauth(idleReauthMinutes);
  const reauthRequired = useReauthRequired();
  // Stamp a fresh activity timestamp (AND clear any gate left raised by a
  // PRIOR session — the gate module cache is a process-wide singleton, not
  // per-user, so without this a signed-out gate could otherwise carry over
  // onto the next signed-in user) whenever the real identity changes: covers
  // login, first-time PIN setup, and biometric unlock (unlock.tsx) — none of
  // which call a shared "session started" function, so this user-keyed effect
  // is the one place all three funnel through.
  useEffect(() => {
    if (realUser) markReauthed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realUser?.id]);

  // Guard — redirect to login if no session
  useEffect(() => {
    if (!user) {
      router.replace('/(auth)/login');
    }
  }, [user]);

  // Keep the write-layer exempt flag in sync with the REAL session user
  // (#199 follow-up) — this reads realUser, not the effective (possibly
  // previewed) user, so a preview into a lower-tier role can never grant
  // itself the tier-4 maintenance exemption; the preview write-block in
  // db/maintenance.ts already covers the opposite direction (blocking writes
  // even for an exempt real identity while previewing).
  useEffect(() => {
    setMaintenanceRole(realUser?.role ?? null);
  }, [realUser]);

  // #246: first-login onboarding checklist. Keyed off realUser (not the
  // effective/previewed user), same identity-sensitive convention as the
  // maintenance-role effect above — a preview-as-role session must never
  // surface (or hide) the REAL signed-in user's own checklist state.
  // `dismissedThisSession` hides the sheet after any row tap (navigating away
  // to complete a task) or the explicit "Got it" WITHOUT re-showing it later
  // in the same session — only "Got it" actually persists the dismissal
  // (dismissOnboardingChecklist, called inside OnboardingChecklistSheet), so a
  // row-tap-away still shows it again next app launch if never formally dismissed.
  const onboarding = useDbQuery(
    () => (realUser ? getOnboardingChecklist(realUser.id) : null),
    [realUser?.id],
    ['user_prefs'],
  );
  const [dismissedThisSession, setDismissedThisSession] = useState(false);

  if (!user) return null;

  return (
    // Wrap the Stack in a View that intercepts all touch starts to reset the
    // idle timer without consuming the event (return false keeps gestures intact)
    <View
      style={{ flex: 1 }}
      onStartShouldSetResponderCapture={() => {
        reset();
        reauth.touch(); // #244: also stamps/re-arms the idle re-auth gate
        appAlertBus.dismissActive(IDLE_NUDGE_TAG); // any activity clears the nudge
        return false;
      }}
    >
      {/* #199 follow-up: preview-as-role banner. Rendered above the
          maintenance banners (topmost of the shell, above the Stack/header)
          so it's visible on every screen while a preview is active without
          crowding any screen's own header. Renders nothing when no preview
          is active. */}
      <PreviewBanner />
      {/* #215: offline strip — renders nothing while connected. */}
      <OfflineBanner />
      {maint.locked && (
        <View style={styles.banLocked}>
          <Text style={styles.banLockedText}>⚠ System under maintenance — read-only</Text>
        </View>
      )}
      {maint.active && !maint.locked && (
        <View style={styles.banAdmin}>
          <Text style={styles.banAdminText}>Maintenance mode is ON — you have admin override</Text>
        </View>
      )}
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.colors.headerBg },
          headerTintColor: t.colors.headerTint,
          headerTitleStyle: { fontWeight: t.typography.weights.bold, fontFamily: t.typography.fontFamily.bold },
          headerRight: () => (
            <View style={styles.headerRight}>
              {canUploadMedia && (
                <TouchableOpacity style={styles.switchBtn} onPress={() => openQuickPhoto()} hitSlop={8}>
                  <Text style={styles.switchText}>📷</Text>
                </TouchableOpacity>
              )}
              <ChatBell />
              <NotificationBell />
              <SyncIndicator />
              <TouchableOpacity
                style={styles.switchBtn}
                onPress={() => {
                  // "Switch" normally keeps the session alive behind the login
                  // screen. For a demo session that would leak the sandbox: its
                  // unsent outbox rows would still be in the DB and the next
                  // real user's sync would push them to the server as their own.
                  // Leaving a test session must always go through logout (wipe).
                  if (user?.is_test) { void logout(); return; }
                  router.push('/(auth)/login');
                }}
              >
                <Text style={styles.switchText}>Switch</Text>
              </TouchableOpacity>
            </View>
          ),
        }}
      >
        {/* The chat group owns its own nested Stack (list + thread with
            per-screen titles), so hide this parent header for it — otherwise the
            parent renders the route-group name "(chat)" over the top (#89). */}
        <Stack.Screen name="(chat)" options={{ headerShown: false }} />
      </Stack>
      <QuickPhotoFlow />
      {realUser && (
        <OnboardingChecklistSheet
          visible={!dismissedThisSession && onboarding?.status === 'pending'}
          userId={realUser.id}
          onClose={() => setDismissedThisSession(true)}
        />
      )}
      {/* #244: rendered LAST (topmost) so a full-screen re-auth requirement
          can interrupt an already-open ModalSheet/ConfirmSheet, not just a
          bare screen — see reauthCore.ts's header comment for the enforcement
          design. Keyed off realUser (never the previewed/effective user). */}
      {realUser && (
        <ReauthGate
          visible={reauthRequired}
          userId={realUser.id}
          userName={realUser.name}
          requiredLength={realUser.pin_length_required}
        />
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12, marginRight: 4 },
  switchBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  switchText: { color: t.colors.headerTint, fontSize: 13, fontWeight: t.typography.weights.semibold },
  banLocked: { backgroundColor: t.colors.warning, paddingVertical: 8, paddingHorizontal: 12 },
  banLockedText: { color: t.colors.onPrimary, fontWeight: t.typography.weights.bold, textAlign: 'center' },
  banAdmin: { backgroundColor: t.colors.brand, paddingVertical: 6, paddingHorizontal: 12 },
  banAdminText: { color: '#E5E7EB', fontSize: 12, textAlign: 'center' },
});
