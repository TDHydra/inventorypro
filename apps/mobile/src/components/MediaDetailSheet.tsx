import { useState, useMemo, useCallback, useEffect } from 'react';
import { View, Text, Image, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { ModalSheet } from './ui/ModalSheet';
import { AppInput } from './ui/AppInput';
import { FieldLabel } from './ui/FieldLabel';
import { PrimaryButton } from './ui/PrimaryButton';
import { SuggestInput } from './SuggestInput';
import { usePermission } from '../hooks/usePermission';
import { useSession } from '../hooks/useSession';
import {
  getMediaDetail, getLocationNoteSuggestions, updateMediaMeta, moveMediaToJob, deleteMedia,
  MediaHubRow,
} from '../db/queries/media';
import { getAllJobs, Job } from '../db/queries/jobs';
import { useDataVersion } from '../hooks/useDataVersion';
import { isMediaUploadPending } from '../sync/outbox';
import { shareMediaExternally } from '../media/shareExternal';

interface Props {
  mediaId: string | null;
  visible: boolean;
  onClose: () => void;
  /** Fired after any mutation (edit/move/delete) so the hub reloads its pages. */
  onChanged: () => void;
}

export function MediaDetailSheet({ mediaId, visible, onClose, onChanged }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user } = useSession();
  const canEdit = usePermission('edit_media');
  const canDelete = usePermission('delete_media');

  const [detail, setDetail] = useState<MediaHubRow | null>(null);
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState('');
  const [locationNote, setLocationNote] = useState('');
  const [moveOpen, setMoveOpen] = useState(false);
  const [jobSearch, setJobSearch] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareSyncPending, setShareSyncPending] = useState(false);
  const dataVersion = useDataVersion();

  const reload = useCallback(() => {
    setDetail(mediaId ? getMediaDetail(mediaId) : null);
  }, [mediaId]);

  // Load on open; drop edit state so a re-open never shows a stale draft.
  useEffect(() => {
    if (!visible) return;
    reload();
    setEditing(false);
    setMoveOpen(false);
    setJobSearch('');
  }, [visible, reload]);

  // Re-read while open when a sync pull applies (kept SEPARATE from the effect
  // above so a bump doesn't reset editing/moveOpen/jobSearch and kick the user
  // out of edit mode). Skipped mid-edit so the caption/locationNote buffers
  // aren't reseeded under the user's typing.
  useEffect(() => {
    if (visible && !editing) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  // #180: "Share externally" mints its link from the server, so it's only safe
  // once this row has actually reached Postgres. Re-checked on a short poll
  // (same idiom as SyncIndicator) rather than once, so a photo opened right
  // after capture enables itself as soon as the background sync catches up —
  // without requiring the user to close and reopen the sheet.
  useEffect(() => {
    if (!visible || !detail) {
      setShareSyncPending(false);
      return;
    }
    const check = () => setShareSyncPending(isMediaUploadPending(detail.id));
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, detail?.id]);

  const handleShare = useCallback(async () => {
    if (!detail) return;
    setSharing(true);
    try {
      await shareMediaExternally(detail.id);
    } finally {
      setSharing(false);
    }
  }, [detail]);

  // Suggest location notes already used on the same job (fresh per edit session).
  const noteSuggestions = useMemo(
    () => (editing && detail?.entity_type === 'job' ? getLocationNoteSuggestions(detail.entity_id) : []),
    [editing, detail],
  );

  // Open jobs first in the move picker; the current job is not a valid target.
  const jobs = useMemo<Job[]>(() => {
    if (!moveOpen) return [];
    const all = getAllJobs(false).filter(j => j.id !== detail?.entity_id);
    return [...all.filter(j => j.status === 'open'), ...all.filter(j => j.status !== 'open')];
  }, [moveOpen, detail, dataVersion]);
  const filteredJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter(j => j.name.toLowerCase().includes(q));
  }, [jobs, jobSearch]);

  const beginEdit = () => {
    if (!detail) return;
    setCaption(detail.caption ?? '');
    setLocationNote(detail.location_note ?? '');
    setEditing(true);
  };

  const saveEdit = () => {
    if (!detail) return;
    updateMediaMeta(
      detail.id,
      { caption: caption.trim() || null, location_note: locationNote.trim() || null },
      user?.id ?? null,
    );
    setEditing(false);
    reload();
    onChanged();
  };

  const confirmMove = (job: Job) => {
    if (!detail) return;
    Alert.alert('Move photo?', `Move this photo to ${job.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Move',
        onPress: () => {
          moveMediaToJob(detail.id, job.id, user?.id ?? null);
          setMoveOpen(false);
          reload();
          onChanged();
        },
      },
    ]);
  };

  const confirmDelete = () => {
    if (!detail) return;
    Alert.alert('Delete this photo?', 'This permanently removes it from every device. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteMedia(detail.id, user?.id ?? null);
          onClose();
          onChanged();
        },
      },
    ]);
  };

  const edited = detail?.updated_at && detail.updated_at !== detail.created_at;

  return (
    <>
      <ModalSheet visible={visible} onClose={onClose} scroll>
        {detail && (
          <>
            {detail.media_type === 'video' ? (
              // No in-app player yet — a static placeholder, not tappable (v1).
              <View style={s.videoBox}>
                <Text style={s.videoPlay}>▶</Text>
                <Text style={s.videoLabel}>Video</Text>
              </View>
            ) : (
              <Image source={{ uri: detail.url }} style={s.image} resizeMode="contain" />
            )}

            <Field label="Uploaded by" value={detail.uploader_name ?? '—'} />
            <Field label="When" value={new Date(detail.created_at).toLocaleString()} />
            {edited ? <Field label="Last edited" value={new Date(detail.updated_at!).toLocaleString()} /> : null}
            {detail.entity_type === 'job' ? (
              <Field
                label="Job"
                value={detail.job_name ? `${detail.job_name} (${detail.job_status ?? '—'})` : '—'}
              />
            ) : (
              <Field label="Attached to" value={detail.entity_type} />
            )}
            {!editing && (
              <>
                <Field label="Caption" value={detail.caption ?? '—'} />
                <Field label="Location note" value={detail.location_note ?? '—'} />
              </>
            )}
            <Field label="Type" value={detail.media_type === 'video' ? 'Video' : 'Image'} />
            <Field label="Primary" value={detail.is_primary === 1 ? 'Yes' : 'No'} />

            {!editing && (
              <>
                {/* #180 v1 — shares a LONG-LIVED LINK via the OS share sheet
                   (RN core Share). File attachment (expo-sharing) is v2, next
                   native rebuild. Disabled + reasoned like PermissionGate's
                   mode="disable" until this row has actually synced to the
                   server — the link is minted server-side. */}
                <PrimaryButton
                  label="Share externally"
                  onPress={handleShare}
                  disabled={shareSyncPending}
                  loading={sharing}
                  style={s.actionBtn}
                />
                {shareSyncPending && (
                  <Text style={s.shareReason}>Share available once this photo finishes syncing.</Text>
                )}
              </>
            )}

            {canEdit && !editing && (
              <PrimaryButton label="Edit details" onPress={beginEdit} style={s.actionBtn} />
            )}

            {canEdit && editing && (
              <View style={s.editBox}>
                <FieldLabel>Caption</FieldLabel>
                <AppInput
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="Caption"
                />
                <SuggestInput
                  label="Location note"
                  value={locationNote}
                  onChange={setLocationNote}
                  placeholder="e.g. Master bedroom"
                  suggestions={noteSuggestions}
                />
                <PrimaryButton label="Save" onPress={saveEdit} />
                <TouchableOpacity onPress={() => setEditing(false)}>
                  <Text style={s.cancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            )}

            {canEdit && !editing && (
              <TouchableOpacity style={s.moveBtn} onPress={() => { setJobSearch(''); setMoveOpen(true); }}>
                <Text style={s.moveText}>Move to another job…</Text>
              </TouchableOpacity>
            )}

            {canDelete && !editing && (
              <PrimaryButton label="Delete" tone="danger" onPress={confirmDelete} style={s.actionBtn} />
            )}
          </>
        )}
      </ModalSheet>

      {/* Nested move-to-job picker (sibling ModalSheet stacks above the detail). */}
      <ModalSheet visible={moveOpen} onClose={() => setMoveOpen(false)} scroll>
        <Text style={s.sheetTitle}>Move to another job</Text>
        <TextInput
          style={s.jobSearch}
          placeholder="Search jobs…"
          placeholderTextColor={t.colors.textMuted}
          value={jobSearch}
          onChangeText={setJobSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {filteredJobs.length === 0 ? (
          <Text style={s.noJobs}>No jobs match.</Text>
        ) : (
          filteredJobs.map(job => (
            <TouchableOpacity key={job.id} style={s.jobRow} onPress={() => confirmMove(job)}>
              <Text style={s.jobName} numberOfLines={1}>{job.name}</Text>
              <Text style={s.jobStatus}>{job.status}</Text>
            </TouchableOpacity>
          ))
        )}
      </ModalSheet>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Text style={s.fieldValue} selectable>{value}</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  image: { width: '100%', height: 300, borderRadius: t.radii.md, backgroundColor: t.colors.border, marginBottom: t.spacing.md },
  videoBox: {
    width: '100%', height: 300, borderRadius: t.radii.md, backgroundColor: '#0F172A',
    alignItems: 'center', justifyContent: 'center', gap: t.spacing.xs, marginBottom: t.spacing.md,
  },
  videoPlay: { color: '#fff', fontSize: 40 },
  videoLabel: { color: t.colors.textMuted, fontSize: t.typography.fontSizes.body2, fontWeight: '600' },

  field: { flexDirection: 'row', justifyContent: 'space-between', gap: t.spacing.md, paddingVertical: 5 },
  fieldLabel: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, flexShrink: 0 },
  fieldValue: { fontSize: t.typography.fontSizes.body2, color: t.colors.textPrimary, flex: 1, textAlign: 'right' },

  actionBtn: { marginTop: t.spacing.md },
  // Same reduced-emphasis convention as PermissionGate's mode="disable" reason.
  shareReason: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },
  editBox: { marginTop: t.spacing.md, gap: t.spacing.md },
  cancelText: { textAlign: 'center', color: t.colors.textSecondary, fontWeight: '600', paddingVertical: t.spacing.xs },
  moveBtn: {
    marginTop: t.spacing.md, paddingVertical: 13, borderRadius: t.radii.lg, alignItems: 'center',
    borderWidth: 1, borderColor: t.colors.primary, backgroundColor: t.colors.primaryBg,
  },
  moveText: { color: t.colors.primaryText, fontWeight: '700', fontSize: t.typography.fontSizes.body },

  sheetTitle: { fontSize: t.typography.fontSizes.base, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.md },
  jobSearch: {
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, height: 44, fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary,
    marginBottom: t.spacing.sm,
  },
  jobRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.md,
    paddingVertical: t.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.colors.borderDetail,
  },
  jobName: { flex: 1, fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  jobStatus: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted },
  noJobs: { fontSize: t.typography.fontSizes.body2, color: t.colors.textMuted, paddingVertical: t.spacing.md, textAlign: 'center' },
});
