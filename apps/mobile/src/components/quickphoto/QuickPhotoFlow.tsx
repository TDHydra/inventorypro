import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from '../../lib/themedAlert';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { useDbQuery } from '../../hooks/useDbQuery';
import { ModalSheet } from '../ui/ModalSheet';
import { PrimaryButton } from '../ui/PrimaryButton';
import { StatusPill } from '../ui/StatusPill';
import { Toast } from '../ui/Toast';
import { confirmSheet } from '../ui/ConfirmSheet';
import { AppInput } from '../ui/AppInput';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { SuggestInput } from '../SuggestInput';
import { getOpenJobs } from '../../db/queries/jobs';
import { getAllActiveUsers, type User } from '../../db/queries/users';
import { getLocationNoteSuggestions, getPoolLocationNoteSuggestions } from '../../db/queries/media';
import { uploadMediaAsset, MediaTooLargeError } from '../../media/upload';
import { shareMediaExternally } from '../../media/shareExternal';
import { isMediaUploadPending } from '../../sync/outbox';
import { syncNow } from '../../sync/engine';
import {
  initialState, open, chooseDest, photoTaken, assetsPicked, cameraCancelled, galleryCancelled,
  saveDone, saveAndAddAnother, cancelDetails, buildUploadInput,
  type QuickPhotoState, type QuickPhotoSource, type QuickPhotoAsset,
} from './quickPhotoLogic';

export interface QuickPhotoOpenOptions {
  /** Defaults to 'camera' (the header camera button's existing behavior). */
  source?: QuickPhotoSource;
}

/**
 * Module-level trigger — same host pattern as `confirmSheet`/`ConfirmSheetHost`
 * (`src/components/ui/ConfirmSheet.tsx`), minus the queue (only one QuickPhoto
 * flow can run at a time, so a single registered callback is enough): the host
 * (`<QuickPhotoFlow />`, mounted once in `app/(app)/_layout.tsx`) registers
 * itself on mount; the header camera button calls `openQuickPhoto()`, and the
 * media hub's Fab calls `openQuickPhoto({ source: 'gallery' })` (#171).
 */
let openFn: ((options?: QuickPhotoOpenOptions) => void) | null = null;

export function openQuickPhoto(options?: QuickPhotoOpenOptions): void {
  openFn?.(options);
}

/** Mount once, alongside the Stack, in `app/(app)/_layout.tsx`. */
export function QuickPhotoFlow() {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();

  const [state, setState] = useState<QuickPhotoState>(() => initialState());
  const [showUserPicker, setShowUserPicker] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(() => new Set());
  const [roomArea, setRoomArea] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // #180 v1: after a "Done" (not "another" — that loops straight into the next
  // capture) upload, offer to share the just-uploaded photo externally. Kept
  // OUTSIDE the quickPhotoLogic phase machine (which the destination/camera/
  // details tests exercise) — this is a purely additive overlay, not a phase.
  const [postCapture, setPostCapture] = useState<{ id: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareSyncPending, setShareSyncPending] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the camera-launch effect so re-renders while the native camera is
  // open (e.g. permission alert dismiss) don't relaunch it; reset whenever the
  // phase leaves 'camera' so the NEXT entry (fresh open, or Save & add another
  // looping back) fires again.
  const cameraLaunchedRef = useRef(false);
  // Same guard, for the gallery picker (#171) — mirrors cameraLaunchedRef.
  const galleryLaunchedRef = useRef(false);

  useEffect(() => {
    openFn = (options) => setState(prev => open(prev, options?.source));
    return () => { openFn = null; };
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  function showToast(message: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }

  // Fresh destination sheet each time it opens — clear any leftover
  // specific-users picker state from a prior run.
  useEffect(() => {
    if (state.phase === 'destination') {
      setShowUserPicker(false);
      setSelectedUserIds(new Set());
    }
  }, [state.phase]);

  // Fresh Room/Note fields for every photo (first capture AND each loop of
  // Save & add another, which resets photoUri before the next capture lands).
  useEffect(() => {
    if (state.phase === 'details') {
      setRoomArea('');
      setNote('');
    }
  }, [state.phase, state.photoUri]);

  // Camera step has no UI of its own — the idiom is MediaGallery.handleCamera
  // (permission → launchCameraAsync → advance the state machine).
  useEffect(() => {
    if (state.phase !== 'camera') {
      cameraLaunchedRef.current = false;
      return;
    }
    if (cameraLaunchedRef.current) return;
    cameraLaunchedRef.current = true;
    void runCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  async function runCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Allow camera access to take photos.');
      setState(prev => cameraCancelled(prev));
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      allowsEditing: false,
    });

    if (result.canceled || result.assets.length === 0) {
      setState(prev => cameraCancelled(prev));
      return;
    }
    setState(prev => photoTaken(prev, result.assets[0].uri));
  }

  // Gallery step has no UI of its own either — mirrors the camera effect above.
  useEffect(() => {
    if (state.phase !== 'gallery') {
      galleryLaunchedRef.current = false;
      return;
    }
    if (galleryLaunchedRef.current) return;
    galleryLaunchedRef.current = true;
    void runGallery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  async function runGallery() {
    // SDK 56 Photo Picker: no permission prompt needed on modern Android/iOS —
    // requestMediaLibraryPermissionsAsync is the legacy-picker-only guard
    // MediaGallery still carries; launchImageLibraryAsync itself hands off to
    // the OS picker, which never touches app-level media permissions.
    // Deliberately no allowsEditing (ignored + warns once allowsMultipleSelection
    // is set), and mediaTypes is the SDK 56 string-array form (the old
    // MediaTypeOptions enum is gone).
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 10,
      quality: 0.85,
    });

    // On cancel `assets` is null, not [] — branch on `canceled`, not length.
    if (result.canceled) {
      setState(prev => galleryCancelled(prev));
      return;
    }
    const assets: QuickPhotoAsset[] = result.assets.map(a => ({
      uri: a.uri,
      mediaType: a.type === 'video' ? 'video' : 'image',
      ext: (a.fileName?.split('.').pop() ?? a.uri.split('.').pop() ?? 'jpg').toLowerCase(),
    }));
    setState(prev => assetsPicked(prev, assets));
  }

  // Re-runs whenever a local write OR a background sync pull touches jobs
  // (#60/#63) — no manual reload key needed.
  const jobOptions: PickerOption[] = useDbQuery(
    () => getOpenJobs().map(j => ({ id: j.id, label: j.name })),
    [state.phase],
    ['jobs'],
  );

  // Same reactivity, for the "specific users" share picker.
  const otherUsers: User[] = useDbQuery(
    () => getAllActiveUsers().filter(u => u.id !== user?.id),
    [state.phase, user?.id],
    ['users'],
  );

  // Room/Area suggestions are pulled from prior media rows — a sync pull that
  // lands new media (this device or another's) should refresh the list.
  const suggestions = useDbQuery(() => {
    if (!state.dest || !user) return [];
    return state.dest.kind === 'job'
      ? getLocationNoteSuggestions(state.dest.jobId)
      : getPoolLocationNoteSuggestions(user.id);
  }, [state.dest, user], ['media']);

  function toggleUser(id: string) {
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function confirmSpecificUsers() {
    setState(prev => chooseDest(prev, { kind: 'pool', audience: 'users', userIds: [...selectedUserIds] }));
  }

  async function handleSave(mode: 'done' | 'another') {
    if (!user || !state.dest || !state.photoUri) return;
    setSaving(true);
    let uploaded: { id: string; url: string };
    try {
      const built = buildUploadInput(state.dest, user.id, roomArea, note);
      uploaded = await uploadMediaAsset({ ...built, mediaType: state.mediaType, ext: state.ext, uri: state.photoUri, userId: user.id });
    } catch (err) {
      // uploadMediaAsset requires connectivity for the presign — surface any
      // failure as a Toast rather than letting it crash the sheet.
      const message = err instanceof MediaTooLargeError
        ? err.message
        : err instanceof Error ? err.message : 'Upload failed.';
      showToast(message);
      setSaving(false);
      return;
    }
    setSaving(false);
    setState(prev => (mode === 'done' ? saveDone(prev) : saveAndAddAnother(prev)));
    // Offer external share only when the flow is actually finishing — "Save &
    // add another" loops straight back into the camera for the next shot.
    if (mode === 'done') {
      setPostCapture({ id: uploaded.id });
      void syncNow(); // best-effort nudge so the share link is ready sooner
    }
  }

  // #180: the share-link mint endpoint reads the media row from Postgres, so
  // it's only safe once the row has actually reached the server — poll on the
  // same short-interval idiom SyncIndicator uses, so a photo that syncs while
  // this panel is open enables itself without the user reopening anything.
  useEffect(() => {
    if (!postCapture) {
      setShareSyncPending(false);
      return;
    }
    const check = () => setShareSyncPending(isMediaUploadPending(postCapture.id));
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, [postCapture]);

  async function handleShare() {
    if (!postCapture) return;
    setSharing(true);
    try {
      await shareMediaExternally(postCapture.id);
    } finally {
      setSharing(false);
    }
  }

  function handleCancelDetails() {
    const dirty = roomArea.trim().length > 0 || note.trim().length > 0;
    if (!dirty) {
      setState(prev => cancelDetails(prev));
      return;
    }
    void confirmSheet({ title: 'Discard photo?', destructive: true }).then(ok => {
      if (ok) setState(prev => cancelDetails(prev));
    });
  }

  return (
    <>
      {/* Destination sheet — "For a job?" picker, or a pool audience pill. */}
      <ModalSheet
        visible={state.phase === 'destination'}
        onClose={() => setState(initialState())}
        scroll
      >
        <Text style={s.title}>For a job?</Text>
        <SearchablePicker
          placeholder="Search jobs..."
          options={jobOptions}
          value={null}
          onSelect={opt => setState(prev => chooseDest(prev, { kind: 'job', jobId: opt.id, jobName: opt.label }))}
        />

        <Text style={s.orText}>— or share to —</Text>

        {!showUserPicker ? (
          <View style={s.pillRow}>
            <Pressable onPress={() => setState(prev => chooseDest(prev, { kind: 'pool', audience: 'team', userIds: [] }))}>
              <StatusPill label="My team" tone="neutral" />
            </Pressable>
            <Pressable onPress={() => setState(prev => chooseDest(prev, { kind: 'pool', audience: 'everyone', userIds: [] }))}>
              <StatusPill label="Everyone" tone="neutral" />
            </Pressable>
            <Pressable onPress={() => setShowUserPicker(true)}>
              <StatusPill label="Specific users" tone="neutral" />
            </Pressable>
          </View>
        ) : (
          <View style={s.userList}>
            {otherUsers.map(u => {
              const checked = selectedUserIds.has(u.id);
              return (
                <Pressable key={u.id} style={s.userRow} onPress={() => toggleUser(u.id)}>
                  <View style={[s.checkbox, checked && s.checkboxOn]}>
                    {checked && <Text style={s.checkMark}>✓</Text>}
                  </View>
                  <Text style={s.userRowLabel}>{u.name}</Text>
                </Pressable>
              );
            })}
            <PrimaryButton
              label="Done"
              onPress={confirmSpecificUsers}
              disabled={selectedUserIds.size === 0}
              style={s.userDoneBtn}
            />
          </View>
        )}
      </ModalSheet>

      {/* Details sheet — Room/Area + Note, then upload. */}
      <ModalSheet visible={state.phase === 'details'} onClose={handleCancelDetails} scroll>
        <Text style={s.title}>Add details</Text>
        <SuggestInput
          label="Room / Area"
          value={roomArea}
          onChange={setRoomArea}
          placeholder="e.g. Master bedroom"
          suggestions={suggestions}
          autoFocus
        />
        <Text style={s.noteLabel}>Note</Text>
        <AppInput
          value={note}
          onChangeText={setNote}
          placeholder="Optional note"
          multiline
          style={s.noteInput}
        />
        {toast !== null && <Toast message={toast} tone="danger" />}
        <PrimaryButton
          label="Done"
          onPress={() => handleSave('done')}
          loading={saving}
          style={s.detailBtn}
        />
        <PrimaryButton
          label="Save & add another"
          onPress={() => handleSave('another')}
          loading={saving}
          style={s.detailBtn}
        />
        <TouchableOpacity style={s.cancelBtn} onPress={handleCancelDetails} disabled={saving}>
          <Text style={s.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </ModalSheet>

      {/* #180 v1 — post-capture share offer. A LINK via the OS share sheet
         (RN core Share), not a file attachment — file sharing (expo-sharing)
         is v2, deferred to the next native rebuild. Separate from the
         destination/camera/details sheets above: this only ever follows a
         completed "Done" upload, never blocks the capture flow itself. */}
      <ModalSheet visible={postCapture !== null} onClose={() => setPostCapture(null)} scroll>
        <Text style={s.title}>Photo saved</Text>
        <PrimaryButton
          label="Share externally"
          onPress={handleShare}
          disabled={shareSyncPending}
          loading={sharing}
          style={s.detailBtn}
        />
        {shareSyncPending && (
          <Text style={s.shareReason}>Share available once this photo finishes syncing.</Text>
        )}
        <TouchableOpacity style={s.cancelBtn} onPress={() => setPostCapture(null)}>
          <Text style={s.cancelBtnText}>Done</Text>
        </TouchableOpacity>
      </ModalSheet>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.base },
  orText: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, textAlign: 'center', marginVertical: t.spacing.base },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  userList: { gap: t.spacing.sm },
  userRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, paddingVertical: 8 },
  checkbox: {
    width: 20, height: 20, borderRadius: 6, borderWidth: 2,
    borderColor: t.colors.textDisabled, alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.surface,
  },
  checkboxOn: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  checkMark: { color: t.colors.surface, fontSize: 13, fontWeight: '800', lineHeight: 16 },
  userRowLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  userDoneBtn: { marginTop: t.spacing.base },
  noteLabel: {
    fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: t.spacing.base, marginBottom: 6,
  },
  noteInput: { minHeight: 80, textAlignVertical: 'top' },
  detailBtn: { marginTop: t.spacing.base },
  // Same reduced-emphasis convention as PermissionGate's mode="disable" reason.
  shareReason: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2, textAlign: 'center' },
  cancelBtn: { alignItems: 'center', paddingVertical: 12, marginTop: t.spacing.sm },
  cancelBtnText: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, fontWeight: '600' },
});
