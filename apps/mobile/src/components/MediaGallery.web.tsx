import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDataVersion } from '../hooks/useDataVersion';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { Alert } from '../lib/themedAlert';
import { useSession } from '../hooks/useSession';
import { usePermission } from '../hooks/usePermission';
import { uploadMediaAsset, MAX_UPLOAD_BYTES } from '../media/upload';
import { MediaRecord, getMediaForEntity, getLocationNoteSuggestions, deleteMedia } from '../db/queries/media';

interface Props {
  entityType: string;
  entityId: string;
  canUpload?: boolean;
  // 'grid' (default) = full multi-photo grid; 'thumb' = a single compact 64×64
  // thumbnail (Quick Add) that reuses the same upload flow.
  variant?: 'grid' | 'thumb';
}

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
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
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
  // NOT (an unstarred gallery must stay unstarred). Both resolve to a SINGLE row,
  // so a transient duplicate (two devices each electing a primary offline, before
  // the server's correction pulls back — bug #50) shows one star, not two.
  const primaryId = media.find(m => m.is_primary === 1)?.id ?? null;
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

  // Shared presign→PUT→local-row+outbox flow lives in src/media/upload.web.ts
  // (also used by the chat composer); this just binds it to this gallery.
  async function uploadOne(item: PendingUpload, locationNote: string | null) {
    if (!user) return;
    await uploadMediaAsset({
      entityType, entityId,
      mediaType: item.mediaType, ext: item.ext, file: item.file, size: item.file.size,
      userId: user.id, locationNote,
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
    <div style={s.container}>
      {/* Hidden file inputs drive capture (camera) and pick (gallery). */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={s.hiddenInput}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void handleCameraFile(f); }}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        style={s.hiddenInput}
        onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; void handleGalleryFiles(fs); }}
      />

      {variant === 'thumb' ? (
        <button
          style={s.thumbBox}
          disabled={uploading}
          onClick={() => { if (canUpload) setPickerOpen(true); else if (primary) setLightbox(primary); }}
        >
          {uploading ? (
            <span style={s.addText}>…</span>
          ) : primary ? (
            <img src={primary.thumbnail_url ?? primary.url} alt="" style={s.thumbBoxImg} />
          ) : (
            <>
              <span style={s.thumbBoxIcon}>＋</span>
              <span style={s.thumbBoxText}>Photo</span>
            </>
          )}
        </button>
      ) : (
        <div style={s.grid}>
          {media.map(m => (
            <button key={m.id} style={s.thumbBtn} onClick={() => setLightbox(m)}>
              <img
                src={m.thumbnail_url ?? m.url}
                alt=""
                style={{ ...s.thumb, ...(m.id === primaryId ? s.thumbPrimary : null) }}
              />
              {m.id === primaryId && <span style={s.primaryBadge}>★</span>}
              {m.media_type === 'video' && <span style={s.videoBadge}>▶</span>}
            </button>
          ))}

          {canUpload && (
            <button style={s.addBtn} onClick={() => setPickerOpen(true)} disabled={uploading}>
              {uploading ? (
                <span style={s.addText}>{progress ?? 'Uploading…'}</span>
              ) : (
                <>
                  <span style={s.addIcon}>＋</span>
                  <span style={s.addText}>Add photo</span>
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Source picker — bottom sheet (mirrors the native MediaGallery sheet) */}
      {pickerOpen && portal(
        <div style={s.sheetOverlay} onClick={() => setPickerOpen(false)}>
          <div style={s.sheet} onClick={(e) => e.stopPropagation()}>
            <div style={s.sheetHandle} />
            <div style={s.sheetTitle}>Add photo or video</div>
            <div style={s.sourceRow}>
              <button style={s.sourceCard} onClick={() => pick(cameraInputRef.current)}>
                <span style={{ ...s.sourceIconWrap, backgroundColor: t.colors.primaryBg }}>📷</span>
                <span style={s.sourceLabel}>Take photo</span>
                <span style={s.sourceSub}>Use the camera</span>
              </button>
              <button style={s.sourceCard} onClick={() => pick(galleryInputRef.current)}>
                <span style={{ ...s.sourceIconWrap, backgroundColor: t.colors.accentBg }}>🖼️</span>
                <span style={s.sourceLabel}>Choose</span>
                <span style={s.sourceSub}>Photo or video</span>
              </button>
            </div>
            <button style={s.sheetCancel} onClick={() => setPickerOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Location-note sheet (job batches) — backdrop close cancels the batch;
          nothing uploads without an explicit Skip / Start Upload. Suggestion
          chips are the DOM analog of native's SuggestInput typeahead. */}
      {pendingBatch && portal(
        <div style={s.sheetOverlay} onClick={() => setPendingBatch(null)}>
          <div style={s.sheet} onClick={(e) => e.stopPropagation()}>
            <div style={s.sheetHandle} />
            <div style={s.sheetTitle}>Where were these taken? (optional)</div>
            <div style={s.noteSub}>Applies to every photo in this batch.</div>
            <input
              style={s.noteInput}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="e.g. Master bedroom"
            />
            {pendingBatch.suggestions.length > 0 && (
              <div style={s.noteChips}>
                {pendingBatch.suggestions.map(sug => (
                  <button key={sug} style={s.noteChip} onClick={() => setNoteText(sug)}>{sug}</button>
                ))}
              </div>
            )}
            <div style={s.noteBtnRow}>
              <button style={s.noteSkipBtn} onClick={() => startBatch(null)}>Skip</button>
              <button style={s.noteStartBtn} onClick={() => startBatch(noteText.trim() || null)}>Start Upload</button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightbox && portal(
        <div style={s.lightbox} onClick={() => setLightbox(null)}>
          <img src={lightbox.url} alt="" style={s.lightboxImg} />
          {canDelete && (
            <button
              style={s.lightboxDelete}
              onClick={(e) => { e.stopPropagation(); confirmDelete(lightbox); }}
            >
              🗑 Delete
            </button>
          )}
          <span style={s.lightboxClose}>✕ Tap to close</span>
        </div>
      )}
    </div>
  );
}

const makeStyles = (t: Theme): Record<string, CSSProperties> => ({
  container: { margin: '8px 0' },
  hiddenInput: { display: 'none' },
  thumbBox: {
    width: 64, height: 64, borderRadius: 10, padding: 0, overflow: 'hidden',
    border: `2px dashed ${t.colors.border}`, cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.background,
  },
  thumbBoxImg: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 8 },
  thumbBoxIcon: { fontSize: 22, color: t.colors.primary, fontWeight: 300, lineHeight: 1 },
  thumbBoxText: { fontSize: 10, color: t.colors.textSecondary, fontWeight: 600 },
  grid: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  thumbBtn: {
    position: 'relative', padding: 0, border: 'none', background: 'none', cursor: 'pointer',
    width: 'calc((100% - 12px) / 3)', aspectRatio: '1 / 1',
  },
  thumb: { width: '100%', height: '100%', borderRadius: 8, backgroundColor: t.colors.border, objectFit: 'cover' },
  thumbPrimary: { border: `2px solid ${t.colors.primary}`, boxSizing: 'border-box' },
  primaryBadge: {
    position: 'absolute', top: 4, left: 4,
    backgroundColor: t.colors.primary, borderRadius: 8, width: 16, height: 16,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: t.colors.onPrimary, fontSize: 10,
  },
  videoBadge: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)', borderRadius: 8,
    color: '#fff', fontSize: 24,
  },
  addBtn: {
    width: 'calc((100% - 12px) / 3)', aspectRatio: '1 / 1', borderRadius: 8,
    border: `2px dashed ${t.colors.border}`, cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.background,
  },
  addIcon: { fontSize: 26, color: t.colors.primary, fontWeight: 300 },
  addText: { fontSize: 11, color: t.colors.textSecondary, fontWeight: 600, marginTop: 2 },
  // Source picker bottom sheet
  sheetOverlay: {
    position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
    justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 1000,
  },
  sheet: {
    backgroundColor: t.colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    padding: '10px 20px 34px', display: 'flex', flexDirection: 'column', gap: 16,
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: t.colors.border, marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: 800, color: t.colors.textPrimary, textAlign: 'center' },
  sourceRow: { display: 'flex', flexDirection: 'row', gap: 12 },
  sourceCard: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '18px 0',
    borderRadius: 16, border: `1px solid ${t.colors.border}`, backgroundColor: t.colors.background, cursor: 'pointer',
  },
  sourceIconWrap: {
    width: 56, height: 56, borderRadius: 28, display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontSize: 26,
  },
  sourceLabel: { fontSize: 15, fontWeight: 700, color: t.colors.textPrimary },
  sourceSub: { fontSize: 12, color: t.colors.textMuted },
  sheetCancel: {
    textAlign: 'center', padding: '12px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
    backgroundColor: t.colors.background, fontSize: 15, fontWeight: 700, color: t.colors.textSecondary,
  },
  // Location-note sheet (job batches)
  noteSub: { fontSize: 12, color: t.colors.textMuted, textAlign: 'center' },
  noteInput: {
    height: 44, borderRadius: 10, border: `1px solid ${t.colors.border}`, padding: '0 14px',
    fontSize: 14, color: t.colors.textPrimary, backgroundColor: t.colors.inputBg,
  },
  noteChips: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  noteChip: {
    padding: '6px 12px', borderRadius: 14, border: `1px solid ${t.colors.border}`,
    backgroundColor: t.colors.background, color: t.colors.textPrimary, fontSize: 13, cursor: 'pointer',
  },
  noteBtnRow: { display: 'flex', flexDirection: 'row', gap: 12, marginTop: 4 },
  noteSkipBtn: {
    flex: 1, padding: '12px 0', borderRadius: 12, border: `1px solid ${t.colors.border}`, cursor: 'pointer',
    backgroundColor: t.colors.background, fontSize: 15, fontWeight: 700, color: t.colors.textSecondary,
  },
  noteStartBtn: {
    flex: 1, padding: '12px 0', borderRadius: 12, border: 'none', cursor: 'pointer',
    backgroundColor: t.colors.primary, fontSize: 15, fontWeight: 700, color: t.colors.onPrimary,
  },
  lightbox: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.92)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  },
  lightboxImg: { width: '100%', height: '80%', objectFit: 'contain' },
  lightboxDelete: {
    marginTop: 16, padding: '10px 24px', borderRadius: 12, border: 'none', cursor: 'pointer',
    backgroundColor: t.colors.danger, color: t.colors.onPrimary, fontSize: 14, fontWeight: 700,
  },
  lightboxClose: { color: '#fff', marginTop: 16, fontSize: 14 },
});
