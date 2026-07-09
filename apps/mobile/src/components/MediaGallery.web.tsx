import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { colors } from '../theme';
import { Alert } from '../lib/themedAlert';
import { useSession } from '../hooks/useSession';
import { usePermission } from '../hooks/usePermission';
import { getDb } from '../db/schema';
import { appendOutbox } from '../sync/outbox';
import { generateUUID } from '../utils/uuid';
import { getValidJwt } from '../auth/session';
import { MediaRecord, getMediaForEntity, getLocationNoteSuggestions, deleteMedia } from '../db/queries/media';

interface Props {
  entityType: string;
  entityId: string;
  canUpload?: boolean;
  // 'grid' (default) = full multi-photo grid; 'thumb' = a single compact 64×64
  // thumbnail (Quick Add) that reuses the same upload flow.
  variant?: 'grid' | 'thumb';
}

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Server rejects uploads whose declared content_length exceeds this; skipping
// client-side saves the doomed round-trip.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

interface PendingUpload {
  file: File;
  mediaType: 'image' | 'video';
  ext: string;
}

// Web has no expo-image-picker / expo-file-system. Capture + pick are handled by
// a native <input type="file">; the upload streams the File (a Blob) straight to
// the presigned URL via fetch PUT — the same /media/upload-url + DB + outbox path
// the native MediaGallery uses, so the DB/sync contract is identical.
export function MediaGallery({ entityType, entityId, canUpload = true, variant = 'grid' }: Props) {
  const { user } = useSession();
  const canDelete = usePermission('delete_media');
  const [media, setMedia] = useState<MediaRecord[]>(() => getMediaForEntity(entityType, entityId));
  const primary = media.find(m => m.is_primary === 1) ?? media[0] ?? null;
  const [lightbox, setLightbox] = useState<MediaRecord | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null); // "Uploading 2 of 5…" for batches
  const [pickerOpen, setPickerOpen] = useState(false);
  // Job uploads pause here for the batch-wide location note before the queue runs.
  const [pendingBatch, setPendingBatch] = useState<{ items: PendingUpload[]; suggestions: string[] } | null>(null);
  const [noteText, setNoteText] = useState('');

  // capture="environment" → rear camera on mobile browsers; no capture → file picker.
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  function notifyError(message: string) {
    if (typeof window !== 'undefined') window.alert(message);
  }

  function extFor(file: File): string {
    const fromName = file.name?.split('.').pop();
    if (fromName && fromName !== file.name) return fromName.toLowerCase();
    const fromType = file.type?.split('/').pop();
    return (fromType ?? 'jpg').toLowerCase();
  }

  function toItem(file: File): PendingUpload {
    return { file, mediaType: file.type.startsWith('video') ? 'video' : 'image', ext: extFor(file) };
  }

  // Camera input stays single-shot and never shows the note sheet (matches native).
  async function handleCameraFile(file: File | undefined | null) {
    if (!file) return;
    await runUploadQueue([toItem(file)], null);
  }

  async function handleGalleryFiles(files: File[]) {
    if (files.length === 0) return;
    const items = files.map(toItem);
    // Job media gets a batch-wide "where were these taken?" note before the
    // queue starts; other entities upload immediately with no note.
    if (entityType === 'job') {
      setNoteText('');
      setPendingBatch({ items, suggestions: getLocationNoteSuggestions(entityId) });
    } else {
      await runUploadQueue(items, null);
    }
  }

  // The note sheet's Skip / Start Upload both land here; close first so the
  // grid's uploading state is visible behind the queue.
  function startBatch(locationNote: string | null) {
    const items = pendingBatch?.items;
    setPendingBatch(null);
    if (items) void runUploadQueue(items, locationNote);
  }

  // Sequential queue — presigned URLs are per-file, so one upload at a time.
  // Per-item failures don't stop the batch; they're summarized in one alert.
  async function runUploadQueue(items: PendingUpload[], locationNote: string | null) {
    if (!user) return;
    setUploading(true);
    let failed = 0;
    let lastError = '';

    try {
      for (let i = 0; i < items.length; i++) {
        if (items.length > 1) setProgress(`Uploading ${i + 1} of ${items.length}…`);

        // Server rejects declared-oversize uploads; skip before the round-trip.
        if (items[i].file.size > MAX_UPLOAD_BYTES) {
          Alert.alert('File Too Large', `"${items[i].file.name}" is over 25 MB and was skipped.`);
          continue;
        }

        try {
          await uploadOne(items[i], locationNote);
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
      // Single-file failures keep the original plain alert with the real error.
      if (items.length === 1) notifyError(lastError);
      else Alert.alert('Upload Failed', `${failed} of ${items.length} uploads failed.`);
    }
  }

  async function uploadOne(item: PendingUpload, locationNote: string | null) {
    if (!user) return;

    // Uploads require online connectivity (presigned URL + direct PUT). The
    // /media/upload-url route is JWT-protected, so attach a fresh token.
    const jwt = await getValidJwt();
    if (!jwt) throw new Error('Connect to the server to upload media.');

    // Get signed upload URL. content_length lets the server enforce the size cap.
    const urlRes = await fetch(`${API_BASE}/media/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        entity_type: entityType, entity_id: entityId, media_type: item.mediaType,
        file_extension: item.ext, content_length: item.file.size,
      }),
    });

    if (!urlRes.ok) throw new Error(`Could not get upload URL (${urlRes.status}).`);
    const { uploadUrl, publicUrl, contentType } = await urlRes.json() as {
      uploadUrl: string; publicUrl: string; contentType: string;
    };

    // Upload directly to MinIO by streaming the File (a Blob) — the browser's
    // fetch handles the body natively (no expo-file-system). The Content-Type
    // MUST equal the value the server signed (contentType), or MinIO rejects
    // with SignatureDoesNotMatch.
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: item.file,
      headers: { 'Content-Type': contentType },
    });
    if (!uploadRes.ok) {
      throw new Error(`Upload failed (${uploadRes.status}).`);
    }

    // First image for an entity becomes its primary photo. Read fresh from the
    // DB (not the stale `media` closure) so concurrent adds don't both claim
    // it — within a batch this also means only the first SUCCESSFUL upload can
    // become primary, and only if the entity had none before.
    const existing = getMediaForEntity(entityType, entityId);
    const isPrimary = existing.length === 0;
    const id = generateUUID();
    const now = new Date().toISOString();

    const db = getDb();
    // updated_at is set locally for immediate ordering; the server stamps its
    // own authoritative NOW() on apply (so it's not in the outbox payload).
    db.executeSync(
      `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, location_note, is_primary, uploaded_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
      [id, entityType, entityId, item.mediaType, publicUrl, locationNote, isPrimary ? 1 : 0, user.id, now, now]
    );

    appendOutbox('INSERT', 'media', {
      id,
      entity_type: entityType,
      entity_id: entityId,
      media_type: item.mediaType,
      url: publicUrl,
      location_note: locationNote,
      is_primary: isPrimary, // boolean — server column is BOOLEAN
      uploaded_by: user.id,
      created_at: now,
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

  function pick(input: HTMLInputElement | null) {
    setPickerOpen(false);
    input?.click();
  }

  // Render overlays into <body> so `position: fixed` is viewport-relative.
  // React Navigation applies a `transform` to the screen container, which would
  // otherwise trap fixed positioning inside that box — dropping the "bottom"
  // sheet into the middle of the screen, superimposed on the form. Portaling out
  // is what react-native-web's <Modal> (used by the native MediaGallery) does.
  const portal = (node: ReactNode): ReactNode =>
    typeof document !== 'undefined' ? createPortal(node, document.body) : node;

  return (
    <div style={styles.container}>
      {/* Hidden file inputs drive capture (camera) and pick (gallery). */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={styles.hiddenInput}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void handleCameraFile(f); }}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={styles.hiddenInput}
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void handleGalleryFiles(fs); }}
      />

      {variant === 'thumb' ? (
        <button
          style={styles.thumbBox}
          disabled={uploading}
          onClick={() => { if (canUpload) setPickerOpen(true); else if (primary) setLightbox(primary); }}
        >
          {uploading ? (
            <span style={styles.addText}>…</span>
          ) : primary ? (
            <img src={primary.thumbnail_url ?? primary.url} alt="" style={styles.thumbBoxImg} />
          ) : (
            <>
              <span style={styles.thumbBoxIcon}>＋</span>
              <span style={styles.thumbBoxText}>Photo</span>
            </>
          )}
        </button>
      ) : (
        <div style={styles.grid}>
          {media.map(m => (
            <button key={m.id} style={styles.thumbBtn} onClick={() => setLightbox(m)}>
              <img
                src={m.thumbnail_url ?? m.url}
                alt=""
                style={{ ...styles.thumb, ...(m.is_primary === 1 ? styles.thumbPrimary : null) }}
              />
              {m.is_primary === 1 && <span style={styles.primaryBadge}>★</span>}
              {m.media_type === 'video' && <span style={styles.videoBadge}>▶</span>}
            </button>
          ))}

          {canUpload && (
            <button style={styles.addBtn} onClick={() => setPickerOpen(true)} disabled={uploading}>
              {uploading ? (
                <span style={styles.addText}>{progress ?? 'Uploading…'}</span>
              ) : (
                <>
                  <span style={styles.addIcon}>＋</span>
                  <span style={styles.addText}>Add photo</span>
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Source picker — bottom sheet (mirrors the native MediaGallery sheet) */}
      {pickerOpen && portal(
        <div style={styles.sheetOverlay} onClick={() => setPickerOpen(false)}>
          <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div style={styles.sheetHandle} />
            <div style={styles.sheetTitle}>Add photo or video</div>
            <div style={styles.sourceRow}>
              <button style={styles.sourceCard} onClick={() => pick(cameraInputRef.current)}>
                <span style={{ ...styles.sourceIconWrap, backgroundColor: colors.primaryBg }}>📷</span>
                <span style={styles.sourceLabel}>Take photo</span>
                <span style={styles.sourceSub}>Use the camera</span>
              </button>
              <button style={styles.sourceCard} onClick={() => pick(galleryInputRef.current)}>
                <span style={{ ...styles.sourceIconWrap, backgroundColor: colors.accentBg }}>🖼️</span>
                <span style={styles.sourceLabel}>Choose</span>
                <span style={styles.sourceSub}>Photo or video</span>
              </button>
            </div>
            <button style={styles.sheetCancel} onClick={() => setPickerOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Location-note sheet (job batches) — backdrop close cancels the batch;
          nothing uploads without an explicit Skip / Start Upload. Suggestion
          chips are the DOM analog of native's SuggestInput typeahead. */}
      {pendingBatch && portal(
        <div style={styles.sheetOverlay} onClick={() => setPendingBatch(null)}>
          <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <div style={styles.sheetHandle} />
            <div style={styles.sheetTitle}>Where were these taken? (optional)</div>
            <div style={styles.noteSub}>Applies to every photo in this batch.</div>
            <input
              style={styles.noteInput}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="e.g. Master bedroom"
            />
            {pendingBatch.suggestions.length > 0 && (
              <div style={styles.noteChips}>
                {pendingBatch.suggestions.map(s => (
                  <button key={s} style={styles.noteChip} onClick={() => setNoteText(s)}>{s}</button>
                ))}
              </div>
            )}
            <div style={styles.noteBtnRow}>
              <button style={styles.noteSkipBtn} onClick={() => startBatch(null)}>Skip</button>
              <button style={styles.noteStartBtn} onClick={() => startBatch(noteText.trim() || null)}>Start Upload</button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightbox && portal(
        <div style={styles.lightbox} onClick={() => setLightbox(null)}>
          <img src={lightbox.url} alt="" style={styles.lightboxImg} />
          {canDelete && (
            <button
              style={styles.lightboxDelete}
              onClick={(e) => { e.stopPropagation(); confirmDelete(lightbox); }}
            >
              🗑 Delete
            </button>
          )}
          <span style={styles.lightboxClose}>✕ Tap to close</span>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: { margin: '8px 0' },
  hiddenInput: { display: 'none' },
  thumbBox: {
    width: 64, height: 64, borderRadius: 10, padding: 0, overflow: 'hidden',
    border: `2px dashed ${colors.border}`, cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.background,
  },
  thumbBoxImg: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 },
  thumbBoxIcon: { fontSize: 22, color: colors.primary, fontWeight: 300, lineHeight: 1 },
  thumbBoxText: { fontSize: 10, color: colors.textSecondary, fontWeight: 600 },
  grid: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumbBtn: {
    position: 'relative', padding: 0, border: 'none', background: 'none', cursor: 'pointer',
    width: 'calc((100% - 12px) / 3)', aspectRatio: '1 / 1',
  },
  thumb: { width: '100%', height: '100%', borderRadius: 8, backgroundColor: colors.border, objectFit: 'cover' },
  thumbPrimary: { border: `2px solid ${colors.primary}`, boxSizing: 'border-box' },
  primaryBadge: {
    position: 'absolute', top: 4, left: 4,
    backgroundColor: colors.primary, borderRadius: 8, width: 16, height: 16,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', fontSize: 10,
  },
  videoBadge: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8,
    color: '#fff', fontSize: 24,
  },
  addBtn: {
    width: 'calc((100% - 12px) / 3)', aspectRatio: '1 / 1', borderRadius: 8,
    border: `2px dashed ${colors.border}`, cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.background,
  },
  addIcon: { fontSize: 26, color: colors.primary, fontWeight: 300 },
  addText: { fontSize: 11, color: colors.textSecondary, fontWeight: 600, marginTop: 2 },
  // Source picker bottom sheet
  sheetOverlay: {
    position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
    justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 1000,
  },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    padding: '10px 20px 34px', display: 'flex', flexDirection: 'column', gap: 16,
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: 800, color: colors.textPrimary, textAlign: 'center' },
  sourceRow: { display: 'flex', flexDirection: 'row', gap: 12 },
  sourceCard: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '18px 0',
    borderRadius: 16, border: `1px solid ${colors.border}`, backgroundColor: colors.background, cursor: 'pointer',
  },
  sourceIconWrap: {
    width: 56, height: 56, borderRadius: 28, display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontSize: 26,
  },
  sourceLabel: { fontSize: 15, fontWeight: 700, color: colors.textPrimary },
  sourceSub: { fontSize: 12, color: colors.textMuted },
  sheetCancel: {
    textAlign: 'center', padding: '12px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
    backgroundColor: colors.background, fontSize: 15, fontWeight: 700, color: colors.textSecondary,
  },
  // Location-note sheet (job batches)
  noteSub: { fontSize: 12, color: colors.textMuted, textAlign: 'center' },
  noteInput: {
    height: 44, borderRadius: 10, border: `1px solid ${colors.border}`, padding: '0 14px',
    fontSize: 14, color: colors.textPrimary, backgroundColor: '#fff',
  },
  noteChips: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  noteChip: {
    padding: '6px 12px', borderRadius: 14, border: `1px solid ${colors.border}`,
    backgroundColor: colors.background, color: colors.textPrimary, fontSize: 13, cursor: 'pointer',
  },
  noteBtnRow: { display: 'flex', flexDirection: 'row', gap: 12, marginTop: 4 },
  noteSkipBtn: {
    flex: 1, padding: '12px 0', borderRadius: 12, border: `1px solid ${colors.border}`, cursor: 'pointer',
    backgroundColor: colors.background, fontSize: 15, fontWeight: 700, color: colors.textSecondary,
  },
  noteStartBtn: {
    flex: 1, padding: '12px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
    backgroundColor: colors.primary, fontSize: 15, fontWeight: 700, color: '#fff',
  },
  lightbox: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.92)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  lightboxImg: { width: '100%', height: '80%', objectFit: 'contain' },
  lightboxDelete: {
    marginTop: 16, padding: '10px 24px', borderRadius: 12, border: 'none', cursor: 'pointer',
    backgroundColor: colors.danger, color: '#fff', fontSize: 14, fontWeight: 700,
  },
  lightboxClose: { color: '#fff', marginTop: 16, fontSize: 14 },
};
