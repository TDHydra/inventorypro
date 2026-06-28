import { useState } from 'react';
import {
  View, Image, TouchableOpacity, StyleSheet, Text, Modal,
  Dimensions, Alert, ActivityIndicator,
} from 'react-native';
import { colors } from '../theme';
import * as ImagePicker from 'expo-image-picker';
// SDK 54+ moved uploadAsync to the /legacy entry point. BINARY_CONTENT streams
// the file straight to the presigned URL natively — avoids RN's "creating blobs
// from ArrayBuffer is not supported" error that fetch(uri).blob() + PUT hits.
import * as FileSystem from 'expo-file-system/legacy';
import { useSession } from '../hooks/useSession';
import { getDb } from '../db/schema';
import { appendOutbox } from '../sync/outbox';
import { generateUUID } from '../utils/uuid';
import { getValidJwt } from '../auth/session';
import { MediaRecord, getMediaForEntity } from '../db/queries/media';

interface Props {
  entityType: string;
  entityId: string;
  canUpload?: boolean;
}

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const { width } = Dimensions.get('window');
const THUMB = (width - 48) / 3;

export function MediaGallery({ entityType, entityId, canUpload = true }: Props) {
  const { user } = useSession();
  const [media, setMedia] = useState<MediaRecord[]>(() => getMediaForEntity(entityType, entityId));
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

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
    });

    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    const ext = (asset.fileName?.split('.').pop() ?? asset.uri.split('.').pop() ?? 'jpg').toLowerCase();
    await uploadMedia(asset.uri, asset.type === 'video' ? 'video' : 'image', ext);
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
    await uploadMedia(asset.uri, 'image', 'jpg');
  }

  async function uploadMedia(localUri: string, mediaType: 'image' | 'video', ext: string) {
    if (!user) return;
    setUploading(true);

    try {
      // Uploads require online connectivity (presigned URL + direct PUT). The
      // /media/upload-url route is JWT-protected, so attach a fresh token.
      const jwt = await getValidJwt();
      if (!jwt) throw new Error('Connect to the server to upload media.');

      // Get signed upload URL
      const urlRes = await fetch(`${API_BASE}/media/upload-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, media_type: mediaType, file_extension: ext }),
      });

      if (!urlRes.ok) throw new Error(`Could not get upload URL (${urlRes.status}).`);
      const { uploadUrl, publicUrl, contentType } = await urlRes.json() as {
        uploadUrl: string; publicUrl: string; contentType: string;
      };

      // Upload directly to MinIO by streaming the file from disk (no JS Blob).
      // The Content-Type MUST equal the value the server signed (contentType),
      // or MinIO rejects with SignatureDoesNotMatch.
      const uploadRes = await FileSystem.uploadAsync(uploadUrl, localUri, {
        httpMethod: 'PUT',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': contentType },
      });
      if (uploadRes.status < 200 || uploadRes.status >= 300) {
        throw new Error(`Upload failed (${uploadRes.status}).`);
      }

      // First image for an entity becomes its primary photo. Read fresh from the
      // DB (not the stale `media` closure) so concurrent adds don't both claim it.
      const existing = getMediaForEntity(entityType, entityId);
      const isPrimary = existing.length === 0;
      const id = generateUUID();
      const now = new Date().toISOString();

      const db = getDb();
      db.executeSync(
        `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, is_primary, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        [id, entityType, entityId, mediaType, publicUrl, isPrimary ? 1 : 0, user.id, now]
      );

      appendOutbox('INSERT', 'media', {
        id,
        entity_type: entityType,
        entity_id: entityId,
        media_type: mediaType,
        url: publicUrl,
        is_primary: isPrimary, // boolean — server column is BOOLEAN
        uploaded_by: user.id,
        created_at: now,
      });

      setMedia(getMediaForEntity(entityType, entityId));
    } catch (err) {
      Alert.alert('Upload Failed', (err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function pick(fn: () => void) {
    setPickerOpen(false);
    // let the sheet dismiss before launching the native camera/library
    setTimeout(fn, 250);
  }

  return (
    <View style={styles.container}>
      <View style={styles.grid}>
        {media.map(m => (
          <TouchableOpacity key={m.id} onPress={() => setLightbox(m.url)}>
            <Image
              source={{ uri: m.thumbnail_url ?? m.url }}
              style={[styles.thumb, m.is_primary === 1 && styles.thumbPrimary]}
            />
            {m.is_primary === 1 && <View style={styles.primaryBadge}><Text style={styles.primaryText}>★</Text></View>}
            {m.media_type === 'video' && <View style={styles.videoBadge}><Text style={styles.videoIcon}>▶</Text></View>}
          </TouchableOpacity>
        ))}

        {canUpload && (
          <TouchableOpacity style={styles.addBtn} onPress={() => setPickerOpen(true)} disabled={uploading}>
            {uploading ? (
              <>
                <ActivityIndicator color={colors.primary} />
                <Text style={styles.addText}>Uploading…</Text>
              </>
            ) : (
              <>
                <Text style={styles.addIcon}>＋</Text>
                <Text style={styles.addText}>Add photo</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Source picker — polished bottom sheet (replaces the bare Alert) */}
      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Add photo or video</Text>
            <View style={styles.sourceRow}>
              <TouchableOpacity style={styles.sourceCard} onPress={() => pick(handleCamera)} activeOpacity={0.85}>
                <View style={[styles.sourceIconWrap, { backgroundColor: colors.primaryBg }]}>
                  <Text style={styles.sourceIcon}>📷</Text>
                </View>
                <Text style={styles.sourceLabel}>Take photo</Text>
                <Text style={styles.sourceSub}>Use the camera</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.sourceCard} onPress={() => pick(handlePickMedia)} activeOpacity={0.85}>
                <View style={[styles.sourceIconWrap, { backgroundColor: colors.accentBg }]}>
                  <Text style={styles.sourceIcon}>🖼️</Text>
                </View>
                <Text style={styles.sourceLabel}>Choose</Text>
                <Text style={styles.sourceSub}>Photo or video</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.sheetCancel} onPress={() => setPickerOpen(false)}>
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Lightbox */}
      <Modal visible={!!lightbox} transparent animationType="fade">
        <TouchableOpacity style={styles.lightbox} onPress={() => setLightbox(null)}>
          {lightbox && (
            <Image
              source={{ uri: lightbox }}
              style={styles.lightboxImg}
              resizeMode="contain"
            />
          )}
          <Text style={styles.lightboxClose}>✕ Tap to close</Text>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginVertical: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumb: { width: THUMB, height: THUMB, borderRadius: 8, backgroundColor: colors.border },
  thumbPrimary: { borderWidth: 2, borderColor: colors.primary },
  primaryBadge: {
    position: 'absolute', top: 4, left: 4,
    backgroundColor: colors.primary, borderRadius: 8, width: 16, height: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { color: '#fff', fontSize: 10 },
  videoBadge: {
    position: 'absolute', inset: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8,
  },
  videoIcon: { color: '#fff', fontSize: 24 },
  addBtn: {
    width: THUMB, height: THUMB, borderRadius: 8,
    borderWidth: 2, borderColor: colors.border, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background,
  },
  addIcon: { fontSize: 26, color: colors.primary, fontWeight: '300' },
  addText: { fontSize: 11, color: colors.textSecondary, fontWeight: '600', marginTop: 2 },
  // Source picker bottom sheet
  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 34, gap: 16,
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  sourceRow: { flexDirection: 'row', gap: 12 },
  sourceCard: {
    flex: 1, alignItems: 'center', gap: 6, paddingVertical: 18,
    borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background,
  },
  sourceIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  sourceIcon: { fontSize: 26 },
  sourceLabel: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  sourceSub: { fontSize: 12, color: colors.textMuted },
  sheetCancel: { alignItems: 'center', paddingVertical: 12, borderRadius: 12, backgroundColor: colors.background },
  sheetCancelText: { fontSize: 15, fontWeight: '700', color: colors.textSecondary },
  lightbox: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  lightboxImg: { width: '100%', height: '80%' },
  lightboxClose: { color: '#fff', marginTop: 16, fontSize: 14 },
});
