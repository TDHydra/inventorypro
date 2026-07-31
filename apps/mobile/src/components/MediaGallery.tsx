import { useEffect, useState } from 'react';
import {
  View, Image, TouchableOpacity, StyleSheet, Text, Modal, Dimensions, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDataVersion } from '../hooks/useDataVersion';
import { Alert } from '../lib/themedAlert';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useSession } from '../hooks/useSession';
import { uploadMediaAsset, MAX_UPLOAD_BYTES } from '../media/upload';
import { MediaRecord, getMediaForEntity, deleteMedia } from '../db/queries/media';
import { ModalSheet } from './ui/ModalSheet';
import { AppInput } from './ui/AppInput';
import { SearchablePicker, type PickerOption } from './SearchablePicker';
import { usePermission } from '../hooks/usePermission';
import { getRooms, addRoom } from '../db/queries/rooms';

interface Props {
  entityType: string;
  entityId: string;
  canUpload?: boolean;
  // 'grid' (default) = full multi-photo grid; 'thumb' = a single compact 64×64
  // thumbnail (used by Quick Add to stay small) that reuses the same upload flow.
  variant?: 'grid' | 'thumb';
}

const { width } = Dimensions.get('window');
const THUMB = (width - 48) / 3;

interface PendingUpload {
  uri: string;
  mediaType: 'image' | 'video';
  ext: string;
}

export function MediaGallery({ entityType, entityId, canUpload = true, variant = 'grid' }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  // Edge-to-edge: the source-picker below is a hand-rolled bottom sheet
  // (justifyContent:'flex-end', fixed paddingBottom), so the transparent
  // gesture/3-button nav bar overlays it without this inset (#163).
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const canDelete = usePermission('delete_media');
  const [media, setMedia] = useState<MediaRecord[]>(() => getMediaForEntity(entityType, entityId));
  // Re-query when a background pull lands new rows (dataVersion bumps) so media
  // from other devices appears without a remount. Safe mid-interaction: the
  // lightbox holds its own MediaRecord, and upload state lives separately.
  const dataVersion = useDataVersion();
  useEffect(() => {
    setMedia(getMediaForEntity(entityType, entityId));
  }, [dataVersion, entityType, entityId]);
  // The hero falls back to the first photo when nothing is flagged; the star does
  // NOT (an unstarred gallery must stay unstarred). Both resolve to a SINGLE row —
  // getMediaForEntity orders is_primary DESC, created_at DESC — so a transient
  // duplicate (two devices each electing a primary offline, before the server's
  // correction pulls back — bug #50) shows one star, not two.
  const primaryId = media.find(m => m.is_primary === 1)?.id ?? null;
  const primary = media.find(m => m.is_primary === 1) ?? media[0] ?? null;
  const [lightbox, setLightbox] = useState<MediaRecord | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null); // "Uploading 2 of 5…" for batches
  const [pickerOpen, setPickerOpen] = useState(false);
  // #173: job uploads (both camera AND gallery) pause here for an autofocused
  // note + a structured room (with quick-add) before the queue runs — every
  // other entity type uploads immediately with neither.
  const [pendingBatch, setPendingBatch] = useState<{ items: PendingUpload[] } | null>(null);
  const [noteText, setNoteText] = useState('');
  const [roomPick, setRoomPick] = useState<PickerOption | null>(null);
  const [roomOptions, setRoomOptions] = useState<PickerOption[]>([]);
  const canCreateRoom = canUpload; // mirrors the server carve-out: upload_media OR edit_inventory

  async function handlePickMedia() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Allow photo library access to upload media.');
      return;
    }

    // SDK 56: mediaTypes is an array of strings ('images' | 'videos'); the old
    // MediaTypeOptions enum is removed.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
      allowsEditing: false,
      allowsMultipleSelection: true,
    });

    if (result.canceled || result.assets.length === 0) return;
    const items: PendingUpload[] = result.assets.map(asset => ({
      uri: asset.uri,
      mediaType: asset.type === 'video' ? 'video' : 'image',
      ext: (asset.fileName?.split('.').pop() ?? asset.uri.split('.').pop() ?? 'jpg').toLowerCase(),
    }));
    promptOrUpload(items);
  }

  async function handleCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Allow camera access to take photos.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      allowsEditing: false,
    });

    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    promptOrUpload([{ uri: asset.uri, mediaType: 'image', ext: 'jpg' }]);
  }

  // #173: job media (camera AND gallery, single shot or batch) pauses for the
  // note+room sheet before the queue runs; every other entity type uploads
  // immediately with neither, unchanged from before #173.
  function promptOrUpload(items: PendingUpload[]) {
    if (entityType === 'job') {
      setNoteText('');
      setRoomPick(null);
      setRoomOptions(getRooms().map(r => ({ id: r.id, label: r.name })));
      setPendingBatch({ items });
    } else {
      void runUploadQueue(items, null, null);
    }
  }

  function createRoomInline(text: string) {
    const id = addRoom(text);
    const opt: PickerOption = { id, label: text.trim() };
    setRoomOptions(prev => (prev.some(o => o.id === id) ? prev : [...prev, opt]));
    setRoomPick(opt);
  }

  // The note sheet's Skip / Start Upload both land here; close first so the
  // grid's uploading state is visible behind the queue.
  function startBatch(caption: string | null, roomId: string | null) {
    const items = pendingBatch?.items;
    setPendingBatch(null);
    if (items) void runUploadQueue(items, caption, roomId);
  }

  // Sequential queue — presigned URLs are per-file, so one upload at a time.
  // Per-item failures don't stop the batch; they're summarized in one alert.
  async function runUploadQueue(items: PendingUpload[], caption: string | null, roomId: string | null) {
    if (!user) return;
    setUploading(true);
    let failed = 0;
    let lastError = '';

    try {
      for (let i = 0; i < items.length; i++) {
        if (items.length > 1) setProgress(`Uploading ${i + 1} of ${items.length}…`);

        // Size the picker-cache file so the server can enforce the 25 MB cap
        // at signing time; if it can't be statted, omit content_length.
        let size: number | undefined;
        try {
          const info = await FileSystem.getInfoAsync(items[i].uri);
          if (info.exists && typeof info.size === 'number') size = info.size;
        } catch { /* size stays undefined */ }

        if (size !== undefined && size > MAX_UPLOAD_BYTES) {
          Alert.alert('File Too Large', 'That file is over 25 MB and was skipped.');
          continue;
        }

        try {
          await uploadOne(items[i], caption, roomId, size);
        } catch (err) {
          failed++;
          lastError = (err as Error).message;
        }
      }
    } finally {
      setProgress(null);
      setUploading(false);
    }

    if (failed > 0) {
      Alert.alert(
        'Upload Failed',
        items.length === 1 ? lastError : `${failed} of ${items.length} uploads failed.`
      );
    }
  }

  // Shared presign→PUT→local-row+outbox flow lives in src/media/upload.ts
  // (also used by the chat composer); this just binds it to this gallery.
  async function uploadOne(item: PendingUpload, caption: string | null, roomId: string | null, size: number | undefined) {
    if (!user) return;
    await uploadMediaAsset({
      entityType, entityId,
      mediaType: item.mediaType, ext: item.ext, uri: item.uri, size,
      userId: user.id, caption, roomId,
    });
    setMedia(getMediaForEntity(entityType, entityId));
  }

  function confirmDelete(item: MediaRecord) {
    Alert.alert('Delete Photo', 'Delete this photo? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteMedia(item.id, user?.id ?? null);
          setLightbox(null);
          setMedia(getMediaForEntity(entityType, entityId));
        },
      },
    ]);
  }

  function pick(fn: () => void) {
    setPickerOpen(false);
    // let the sheet dismiss before launching the native camera/library
    setTimeout(fn, 250);
  }

  // Shared between the grid and thumb variants (each has its own return tree).
  // Backdrop close cancels the batch — nothing uploads without an explicit
  // Skip / Start Upload.
  const noteSheetModal = (
    <ModalSheet visible={!!pendingBatch} onClose={() => setPendingBatch(null)}>
      <View style={s.noteBody}>
        <Text style={s.noteTitle}>Add a note & room (optional)</Text>
        <Text style={s.noteSub}>Applies to every photo in this batch.</Text>
        <AppInput
          value={noteText}
          onChangeText={setNoteText}
          placeholder="Note — e.g. water stain on ceiling"
          autoFocus
        />
        <SearchablePicker
          placeholder="Room / area"
          options={roomOptions}
          value={roomPick}
          onSelect={setRoomPick}
          onCreate={canCreateRoom ? createRoomInline : undefined}
        />
        <View style={s.noteBtnRow}>
          <TouchableOpacity style={s.noteSkipBtn} onPress={() => startBatch(null, null)}>
            <Text style={s.noteSkipText}>Skip</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.noteStartBtn} onPress={() => startBatch(noteText.trim() || null, roomPick?.id ?? null)}>
            <Text style={s.noteStartText}>Start Upload</Text>
          </TouchableOpacity>
        </View>
      </View>
    </ModalSheet>
  );

  const lightboxModal = (
    <Modal visible={!!lightbox} transparent animationType="fade">
      <TouchableOpacity style={s.lightbox} onPress={() => setLightbox(null)}>
        {lightbox && (
          <Image source={{ uri: lightbox.url }} style={s.lightboxImg} resizeMode="contain" />
        )}
        {canDelete && lightbox && (
          <TouchableOpacity style={s.lightboxDelete} onPress={() => confirmDelete(lightbox)}>
            <Text style={s.lightboxDeleteText}>🗑 Delete</Text>
          </TouchableOpacity>
        )}
        <Text style={s.lightboxClose}>✕ Tap to close</Text>
      </TouchableOpacity>
    </Modal>
  );

  if (variant === 'thumb') {
    return (
      <View>
        <TouchableOpacity
          style={s.thumbBox}
          activeOpacity={0.8}
          disabled={uploading}
          onPress={() => {
            if (canUpload) setPickerOpen(true);
            else if (primary) setLightbox(primary);
          }}
        >
          {uploading ? (
            <ActivityIndicator color={t.colors.primary} />
          ) : primary ? (
            <Image source={{ uri: primary.thumbnail_url ?? primary.url }} style={s.thumbBoxImg} />
          ) : (
            <>
              <Text style={s.thumbBoxIcon}>＋</Text>
              <Text style={s.thumbBoxText}>Photo</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Source picker — shared with the grid variant */}
        <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
          <TouchableOpacity style={s.sheetOverlay} activeOpacity={1} onPress={() => setPickerOpen(false)}>
            <View style={[s.sheet, { paddingBottom: 34 + insets.bottom }]}>
              <View style={s.sheetHandle} />
              <Text style={s.sheetTitle}>Add photo or video</Text>
              <View style={s.sourceRow}>
                <TouchableOpacity style={s.sourceCard} onPress={() => pick(handleCamera)} activeOpacity={0.85}>
                  <View style={[s.sourceIconWrap, { backgroundColor: t.colors.primaryBg }]}>
                    <Text style={s.sourceIcon}>📷</Text>
                  </View>
                  <Text style={s.sourceLabel}>Take photo</Text>
                  <Text style={s.sourceSub}>Use the camera</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.sourceCard} onPress={() => pick(handlePickMedia)} activeOpacity={0.85}>
                  <View style={[s.sourceIconWrap, { backgroundColor: t.colors.accentBg }]}>
                    <Text style={s.sourceIcon}>🖼️</Text>
                  </View>
                  <Text style={s.sourceLabel}>Choose</Text>
                  <Text style={s.sourceSub}>Photo or video</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={s.sheetCancel} onPress={() => setPickerOpen(false)}>
                <Text style={s.sheetCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        {noteSheetModal}
        {lightboxModal}
      </View>
    );
  }

  return (
    <View style={s.container}>
      <View style={s.grid}>
        {media.map(m => (
          <TouchableOpacity key={m.id} onPress={() => setLightbox(m)}>
            <Image
              source={{ uri: m.thumbnail_url ?? m.url }}
              style={[s.thumb, m.id === primaryId && s.thumbPrimary]}
            />
            {m.id === primaryId && <View style={s.primaryBadge}><Text style={s.primaryText}>★</Text></View>}
            {m.media_type === 'video' && <View style={s.videoBadge}><Text style={s.videoIcon}>▶</Text></View>}
          </TouchableOpacity>
        ))}

        {canUpload && (
          <TouchableOpacity style={s.addBtn} onPress={() => setPickerOpen(true)} disabled={uploading}>
            {uploading ? (
              <>
                <ActivityIndicator color={t.colors.primary} />
                <Text style={s.addText}>{progress ?? 'Uploading…'}</Text>
              </>
            ) : (
              <>
                <Text style={s.addIcon}>＋</Text>
                <Text style={s.addText}>Add photo</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Source picker — polished bottom sheet (replaces the bare Alert) */}
      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={s.sheetOverlay} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={[s.sheet, { paddingBottom: 34 + insets.bottom }]}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle}>Add photo or video</Text>
            <View style={s.sourceRow}>
              <TouchableOpacity style={s.sourceCard} onPress={() => pick(handleCamera)} activeOpacity={0.85}>
                <View style={[s.sourceIconWrap, { backgroundColor: t.colors.primaryBg }]}>
                  <Text style={s.sourceIcon}>📷</Text>
                </View>
                <Text style={s.sourceLabel}>Take photo</Text>
                <Text style={s.sourceSub}>Use the camera</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.sourceCard} onPress={() => pick(handlePickMedia)} activeOpacity={0.85}>
                <View style={[s.sourceIconWrap, { backgroundColor: t.colors.accentBg }]}>
                  <Text style={s.sourceIcon}>🖼️</Text>
                </View>
                <Text style={s.sourceLabel}>Choose</Text>
                <Text style={s.sourceSub}>Photo or video</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={s.sheetCancel} onPress={() => setPickerOpen(false)}>
              <Text style={s.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {noteSheetModal}
      {lightboxModal}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { marginVertical: 8 },
  // Compact 64×64 thumbnail variant (Quick Add).
  thumbBox: {
    width: 64, height: 64, borderRadius: 10,
    borderWidth: 2, borderColor: t.colors.border, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    backgroundColor: t.colors.background,
  },
  thumbBoxImg: { width: '100%', height: '100%', borderRadius: 8 },
  thumbBoxIcon: { fontSize: 22, color: t.colors.primary, fontWeight: '300', lineHeight: 24 },
  thumbBoxText: { fontSize: 10, color: t.colors.textSecondary, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumb: { width: THUMB, height: THUMB, borderRadius: 8, backgroundColor: t.colors.border },
  thumbPrimary: { borderWidth: 2, borderColor: t.colors.primary },
  primaryBadge: {
    position: 'absolute', top: 4, left: 4,
    backgroundColor: t.colors.primary, borderRadius: 8, width: 16, height: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { color: t.colors.onPrimary, fontSize: 10 },
  videoBadge: {
    position: 'absolute', inset: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8,
  },
  videoIcon: { color: '#fff', fontSize: 24 },
  addBtn: {
    width: THUMB, height: THUMB, borderRadius: 8,
    borderWidth: 2, borderColor: t.colors.border, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.background,
  },
  addIcon: { fontSize: 26, color: t.colors.primary, fontWeight: '300' },
  addText: { fontSize: 11, color: t.colors.textSecondary, fontWeight: '600', marginTop: 2 },
  // Source picker bottom sheet
  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: t.colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 34, gap: 16,
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: t.colors.border, marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: t.colors.textPrimary, textAlign: 'center' },
  sourceRow: { flexDirection: 'row', gap: 12 },
  sourceCard: {
    flex: 1, alignItems: 'center', gap: 6, paddingVertical: 18,
    borderRadius: 16, borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
  },
  sourceIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  sourceIcon: { fontSize: 26 },
  sourceLabel: { fontSize: 15, fontWeight: '700', color: t.colors.textPrimary },
  sourceSub: { fontSize: 12, color: t.colors.textMuted },
  sheetCancel: { alignItems: 'center', paddingVertical: 12, borderRadius: 12, backgroundColor: t.colors.background },
  sheetCancelText: { fontSize: 15, fontWeight: '700', color: t.colors.textSecondary },
  // Location-note sheet (job batches)
  noteBody: { gap: 14 },
  noteTitle: { fontSize: 17, fontWeight: '800', color: t.colors.textPrimary, textAlign: 'center' },
  noteSub: { fontSize: 12, color: t.colors.textMuted, textAlign: 'center' },
  noteBtnRow: { flexDirection: 'row', gap: 12, marginTop: 4 },
  noteSkipBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 12,
    borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
  },
  noteSkipText: { fontSize: 15, fontWeight: '700', color: t.colors.textSecondary },
  noteStartBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 12, backgroundColor: t.colors.primary },
  noteStartText: { fontSize: 15, fontWeight: '700', color: t.colors.onPrimary },
  lightbox: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  lightboxImg: { width: '100%', height: '80%' },
  lightboxDelete: { marginTop: 16, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 12, backgroundColor: t.colors.danger },
  lightboxDeleteText: { color: t.colors.onPrimary, fontSize: 14, fontWeight: '700' },
  lightboxClose: { color: '#fff', marginTop: 16, fontSize: 14 },
});
