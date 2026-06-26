import { useState } from 'react';
import {
  View, Image, TouchableOpacity, StyleSheet, Text, Modal,
  Dimensions, Alert, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
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

      // Upload directly to MinIO. The Content-Type MUST equal the value the
      // server signed (contentType), or MinIO rejects with SignatureDoesNotMatch.
      const fileRes = await fetch(localUri);
      const blob = await fileRes.blob();
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: blob,
      });
      if (!uploadRes.ok) throw new Error(`Upload failed (${uploadRes.status}).`);

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

  function showOptions() {
    Alert.alert('Add Media', undefined, [
      { text: 'Take Photo', onPress: handleCamera },
      { text: 'Choose from Library', onPress: handlePickMedia },
      { text: 'Cancel', style: 'cancel' },
    ]);
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
          <TouchableOpacity style={styles.addBtn} onPress={showOptions} disabled={uploading}>
            {uploading ? (
              <ActivityIndicator color="#2563EB" />
            ) : (
              <>
                <Text style={styles.addIcon}>+</Text>
                <Text style={styles.addText}>Add</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

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
  thumb: { width: THUMB, height: THUMB, borderRadius: 8, backgroundColor: '#E2E8F0' },
  thumbPrimary: { borderWidth: 2, borderColor: '#2563EB' },
  primaryBadge: {
    position: 'absolute', top: 4, left: 4,
    backgroundColor: '#2563EB', borderRadius: 8, width: 16, height: 16,
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
    borderWidth: 2, borderColor: '#E2E8F0', borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#F8FAFF',
  },
  addIcon: { fontSize: 24, color: '#94A3B8' },
  addText: { fontSize: 12, color: '#94A3B8' },
  lightbox: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  lightboxImg: { width: '100%', height: '80%' },
  lightboxClose: { color: '#fff', marginTop: 16, fontSize: 14 },
});
