import { useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getJobById, getJobDeployments, archiveJob, updateJobFields, Job,
} from '../../../src/db/queries/jobs';
import { getLogForJob, LogEntry } from '../../../src/db/queries/log';
import { usePermission } from '../../../src/hooks/usePermission';
import { MediaGallery } from '../../../src/components/MediaGallery';

type LogWithUser = LogEntry & { user_name?: string };

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canEdit = usePermission('create_jobs');
  const canClose = usePermission('close_jobs');
  const canUpload = usePermission('upload_media');

  const [job, setJob] = useState<Job | null>(() => getJobById(id));
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<string>('');

  const deployments = useMemo(() => getJobDeployments(id), [id]);
  const log = useMemo<LogWithUser[]>(() => getLogForJob(id) as LogWithUser[], [id]);

  function reload() {
    setJob(getJobById(id));
  }

  if (!job) {
    return (
      <>
        <Stack.Screen options={{ title: 'Job', headerShown: true }} />
        <View style={s.center}><Text style={s.muted}>Job not found.</Text></View>
      </>
    );
  }

  function startEdit() {
    setEditName(job!.name);
    setEditStatus(job!.status);
    setEditing(true);
  }

  function saveEdit() {
    const trimmed = editName.trim();
    if (!trimmed) { Alert.alert('Required', 'Job name is required.'); return; }
    updateJobFields(id, { name: trimmed, status: editStatus });
    setEditing(false);
    reload();
  }

  function doArchive() {
    Alert.alert(
      'Archive Job',
      `Archive "${job!.name}"? It will be hidden from active lists.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive', style: 'destructive',
          onPress: () => { archiveJob(id); router.back(); },
        },
      ],
    );
  }

  const badgeBg = job.status === 'open' ? '#DBEAFE'
    : job.status === 'closed' ? '#F1F5F9'
    : '#FEF3C7';
  const badgeFg = job.status === 'open' ? '#1D4ED8'
    : job.status === 'closed' ? '#475569'
    : '#92400E';

  return (
    <>
      <Stack.Screen options={{ title: editing ? 'Edit Job' : job.name, headerShown: true }} />
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

          {editing ? (
            <>
              <View style={s.fieldWrap}>
                <Text style={s.fieldLabel}>Job Name *</Text>
                <TextInput
                  style={s.input}
                  value={editName}
                  onChangeText={setEditName}
                  autoFocus
                  placeholder="Job name"
                  placeholderTextColor="#94A3B8"
                />
              </View>

              <View style={s.fieldWrap}>
                <Text style={s.fieldLabel}>Status</Text>
                <View style={s.chipRow}>
                  {(['open', 'closed', 'archived'] as const).map(st => (
                    <TouchableOpacity
                      key={st}
                      style={[s.chip, editStatus === st && s.chipActive]}
                      onPress={() => setEditStatus(st)}
                    >
                      <Text style={[s.chipText, editStatus === st && s.chipTextActive]}>
                        {st.charAt(0).toUpperCase() + st.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={s.row}>
                <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => setEditing(false)}>
                  <Text style={s.btnGhostText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={saveEdit}>
                  <Text style={s.btnPrimaryText}>Save Changes</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              {/* Header card */}
              <View style={s.card}>
                <Text style={s.name}>{job.name}</Text>
                <View style={s.headerRow}>
                  <View style={[s.statusBadge, { backgroundColor: badgeBg }]}>
                    <Text style={[s.statusBadgeText, { color: badgeFg }]}>
                      {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                    </Text>
                  </View>
                  <Text style={s.dateText}>
                    Created {new Date(job.created_at).toLocaleDateString()}
                  </Text>
                </View>
              </View>

              {/* Deployed section */}
              <Text style={s.sectionLabel}>Deployed</Text>
              <View style={s.card}>
                {deployments.units.length === 0 && deployments.items.length === 0 ? (
                  <Text style={s.muted}>No deployed equipment or items.</Text>
                ) : (
                  <>
                    {deployments.units.map((u, i) => (
                      <View
                        key={String(u.id)}
                        style={[
                          s.deployRow,
                          (i < deployments.units.length - 1 || deployments.items.length > 0) && s.divider,
                        ]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={s.deployTag}>{String(u.asset_tag)}</Text>
                          <Text style={s.deploySub}>{String(u.item_name)}</Text>
                        </View>
                        <View style={s.typeBadge}>
                          <Text style={s.typeBadgeText}>Unit</Text>
                        </View>
                      </View>
                    ))}
                    {deployments.items.map((it, i) => (
                      <View
                        key={String(it.id)}
                        style={[s.deployRow, i < deployments.items.length - 1 && s.divider]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={s.deployTag}>{String(it.item_name)}</Text>
                          <Text style={s.deploySub}>{String(it.quantity)} {String(it.unit)}</Text>
                        </View>
                        <View style={[s.typeBadge, s.typeBadgeItem]}>
                          <Text style={[s.typeBadgeText, s.typeBadgeItemText]}>Item</Text>
                        </View>
                      </View>
                    ))}
                  </>
                )}
              </View>

              {/* Activity section */}
              <Text style={s.sectionLabel}>Activity</Text>
              <View style={s.card}>
                {log.length === 0 ? (
                  <Text style={s.muted}>No activity yet.</Text>
                ) : (
                  log.map((entry, i) => (
                    <View
                      key={entry.id}
                      style={[s.logRow, i < log.length - 1 && s.divider]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={s.logAction}>{entry.action.replace(/_/g, ' ')}</Text>
                        {!!entry.user_name && (
                          <Text style={s.logUser}>{entry.user_name}</Text>
                        )}
                        {!!entry.note && (
                          <Text style={s.logNote}>{entry.note}</Text>
                        )}
                      </View>
                      <Text style={s.logDate}>
                        {new Date(entry.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                  ))
                )}
              </View>

              {/* Photos section */}
              <Text style={s.sectionLabel}>Photos</Text>
              <MediaGallery entityType="job" entityId={id} canUpload={canUpload} />

              {/* Actions */}
              {(canEdit || canClose) && (
                <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={startEdit}>
                  <Text style={s.btnPrimaryText}>Edit Job</Text>
                </TouchableOpacity>
              )}
              {canEdit && job.status !== 'archived' && (
                <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={doArchive}>
                  <Text style={s.btnDangerText}>Archive Job</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: '#94A3B8' },

  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: '#EEF2F7',
  },
  name: { fontSize: 22, fontWeight: '700', color: '#1E3A5F' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  statusBadgeText: { fontSize: 13, fontWeight: '700' },
  dateText: { fontSize: 13, color: '#94A3B8' },

  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4,
  },
  divider: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },

  deployRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  deployTag: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
  deploySub: { fontSize: 12, color: '#64748B', marginTop: 2 },
  typeBadge: {
    backgroundColor: '#DBEAFE', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  typeBadgeText: { fontSize: 12, fontWeight: '700', color: '#1D4ED8' },
  typeBadgeItem: { backgroundColor: '#D1FAE5' },
  typeBadgeItemText: { color: '#065F46' },

  logRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12 },
  logAction: {
    fontSize: 14, fontWeight: '600', color: '#1E293B', textTransform: 'capitalize',
  },
  logUser: { fontSize: 12, color: '#64748B', marginTop: 2 },
  logNote: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  logDate: { fontSize: 12, color: '#94A3B8', marginLeft: 12 },

  fieldWrap: { gap: 6 },
  fieldLabel: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1,
    borderColor: '#E2E8F0', paddingHorizontal: 14, height: 44,
    fontSize: 14, color: '#1E293B',
  },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 8,
    borderWidth: 1, borderColor: '#CBD5E1', backgroundColor: '#fff',
  },
  chipActive: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  chipText: { fontSize: 14, fontWeight: '600', color: '#64748B' },
  chipTextActive: { color: '#fff' },

  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8, flex: 1 },
  btnPrimary: { backgroundColor: '#2563EB' },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnGhost: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#CBD5E1' },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
  btnDanger: { backgroundColor: '#FEF2F2', borderWidth: 1, borderColor: '#FECACA' },
  btnDangerText: { color: '#DC2626', fontWeight: '700', fontSize: 16 },
});
