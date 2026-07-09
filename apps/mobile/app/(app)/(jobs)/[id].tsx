import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import * as Location from 'expo-location';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getJobById, getJobDeployments, archiveJob, updateJobFields, Job,
} from '../../../src/db/queries/jobs';
import { getLogForJob, appendLog, LogEntry } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { getAllLocations } from '../../../src/db/queries/locations';
import { getAllTeams, getTeamById } from '../../../src/db/queries/teams';
import { getTaxonomyTypesWithFallback, getTypeIcon } from '../../../src/db/queries/taxonomy';
import { ROLE_TIER } from '../../../src/constants/roles';
import { renderIcon } from '../../../src/constants/locationStyles';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useFocusRefresh } from '../../../src/hooks/useFocusRefresh';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { MapDisplay } from '../../../src/components/MapDisplay';
import { colors } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { Card } from '../../../src/components/ui/Card';
import { RequestApprovalSheet } from '../../../src/components/RequestApprovalSheet';

type LogWithUser = LogEntry & { user_name?: string };

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const canEdit = usePermission('create_jobs');
  const canClose = usePermission('close_jobs');
  const canUpload = usePermission('upload_media');
  const refreshKey = useFocusRefresh();

  const [job, setJob] = useState<Job | null>(() => getJobById(id));
  const [editing, setEditing] = useState(false);
  const [siteCoords, setSiteCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [geocodeFailed, setGeocodeFailed] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);

  // Geocode the free-text site address (online, no API key) so we can show a
  // view-only map. Failures/empties are swallowed — the map just doesn't appear.
  const siteAddress = job?.site_address ?? null;
  useEffect(() => {
    let cancelled = false;
    setSiteCoords(null);
    setGeocodeFailed(false);
    if (!siteAddress) return;
    (async () => {
      try {
        const r = await Location.geocodeAsync(siteAddress);
        if (cancelled) return;
        if (r[0] && typeof r[0].latitude === 'number' && typeof r[0].longitude === 'number') {
          setSiteCoords({ latitude: r[0].latitude, longitude: r[0].longitude });
        } else {
          setGeocodeFailed(true);
        }
      } catch {
        if (!cancelled) setGeocodeFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [siteAddress]);

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<string>('');
  const [editCustomerName, setEditCustomerName] = useState('');
  const [editSiteAddress, setEditSiteAddress] = useState('');
  const [editSiteLocation, setEditSiteLocation] = useState<PickerOption | null>(null);
  const [editDescription, setEditDescription] = useState('');
  const [editType, setEditType] = useState<string | null>(null);
  const [editReferenceNumber, setEditReferenceNumber] = useState('');
  const [editInsuranceCarrier, setEditInsuranceCarrier] = useState('');

  const jobTypes = useMemo(() => getTaxonomyTypesWithFallback('job'), [refreshKey]);
  const deployments = useMemo(() => getJobDeployments(id), [id, refreshKey]);
  const log = useMemo<LogWithUser[]>(() => getLogForJob(id) as LogWithUser[], [id, refreshKey]);

  const locationOptions = useMemo((): PickerOption[] => {
    return getAllLocations().map(l => ({ id: l.id, label: l.name }));
  }, [refreshKey]);

  // Owning team. Only teams this device holds are offerable — a non-org user's
  // scoped pull leaves only their own teams here. Org authority is the tier test
  // (>= 3), NOT the manage_teams permission (tier-2 team managers hold that).
  const isOrgAuthority = !!user && (ROLE_TIER[user.role] ?? 0) >= 3;
  const teamOptions = useMemo((): PickerOption[] =>
    getAllTeams().map(t => ({ id: t.id, label: t.name })), [refreshKey]);
  const teamName = useMemo(() => {
    if (!job?.team_id) return null;
    return getTeamById(job.team_id)?.name ?? 'Assigned team';
  }, [job?.team_id, refreshKey]);

  // Team-change flow (org authority only), kept out of the generic edit form so a
  // tier-2 create_jobs editor can't reassign teams.
  const [teamEditing, setTeamEditing] = useState(false);
  const [teamPick, setTeamPick] = useState<PickerOption | null>(null);

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
    setEditCustomerName(job!.customer_name ?? '');
    setEditSiteAddress(job!.site_address ?? '');
    setEditDescription(job!.description ?? '');
    setEditType(job!.type ?? null);
    setEditReferenceNumber(job!.reference_number ?? '');
    setEditInsuranceCarrier(job!.insurance_carrier ?? '');
    // Pre-populate site location picker if set
    if (job!.site_location_id) {
      const match = locationOptions.find(l => l.id === job!.site_location_id);
      setEditSiteLocation(match ?? null);
    } else {
      setEditSiteLocation(null);
    }
    setEditing(true);
  }

  function saveEdit() {
    const trimmed = editName.trim();
    if (!trimmed) { Alert.alert('Required', 'Job name is required.'); return; }
    if (!user) { Alert.alert('Error', 'Not logged in.'); return; }

    const fields = {
      name: trimmed,
      status: editStatus,
      customer_name: editCustomerName.trim() || null,
      site_address: editSiteAddress.trim() || null,
      site_location_id: editSiteLocation?.id ?? null,
      description: editDescription.trim() || null,
      type: editType || null,
      reference_number: editReferenceNumber.trim() || null,
      insurance_carrier: editInsuranceCarrier.trim() || null,
    };

    // Field update + audit log must commit together; on failure keep the edit
    // form open (don't close/reload) so the user can retry without losing input.
    try {
      runInTransaction(() => {
        updateJobFields(id, fields);
        appendLog({
          action: 'job_updated',
          entity_type: 'job',
          entity_id: id,
          user_id: user.id,
          note: trimmed,
          team_id: null,
          from_location_id: null,
          to_location_id: null,
          quantity: null,
          unit: null,
          job_id: id,
          metadata: null,
          device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not save changes', e instanceof Error ? e.message : 'Your changes could not be saved. Please try again.');
      return;
    }

    setEditing(false);
    reload();
  }

  function startTeamEdit() {
    const cur = job!.team_id ? (teamOptions.find(t => t.id === job!.team_id) ?? null) : null;
    setTeamPick(cur);
    setTeamEditing(true);
  }

  function commitTeam() {
    if (!user) { Alert.alert('Error', 'Not logged in.'); return; }
    const newTeamId = teamPick?.id ?? null;
    const currentTeamId = job!.team_id ?? null;
    if (newTeamId === currentTeamId) { setTeamEditing(false); return; }

    const apply = () => {
      // team_id change + audit log commit together; keep the picker open on
      // failure so the user can retry.
      try {
        runInTransaction(() => {
          updateJobFields(id, { team_id: newTeamId });
          appendLog({
            action: 'job_updated',
            entity_type: 'job',
            entity_id: id,
            user_id: user.id,
            note: newTeamId ? `Team: ${teamPick!.label}` : 'Team: org-wide',
            team_id: newTeamId,
            from_location_id: null,
            to_location_id: null,
            quantity: null,
            unit: null,
            job_id: id,
            metadata: null,
            device_id: null,
          });
        });
      } catch (e) {
        Alert.alert('Could not change team', e instanceof Error ? e.message : 'The team could not be changed. Please try again.');
        return;
      }
      setTeamEditing(false);
      reload();
    };

    // Assigning a job to a team narrows who can see it: the scoped pull returns
    // only org-wide jobs plus the viewer's own teams, so the job vanishes from
    // every non-member's device on their next sync. Confirm before that happens.
    if (newTeamId !== null) {
      Alert.alert(
        'Assign to team?',
        `"${job!.name}" will move to ${teamPick!.label}. It will disappear from the devices of anyone not on that team on their next sync.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Assign', onPress: apply },
        ],
      );
    } else {
      apply();
    }
  }

  function doArchive() {
    if (!user) { Alert.alert('Error', 'Not logged in.'); return; }
    Alert.alert(
      'Archive Job',
      `Archive "${job!.name}"? It will be hidden from active lists.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive', style: 'destructive',
          onPress: () => {
            // Archive + audit log atomically; only navigate away once committed
            // so a failed archive doesn't leave the user thinking it worked.
            try {
              runInTransaction(() => {
                archiveJob(id);
                appendLog({
                  action: 'job_archived',
                  entity_type: 'job',
                  entity_id: id,
                  user_id: user.id,
                  note: job!.name,
                  team_id: null,
                  from_location_id: null,
                  to_location_id: null,
                  quantity: null,
                  unit: null,
                  job_id: id,
                  metadata: null,
                  device_id: null,
                });
              });
            } catch (e) {
              Alert.alert('Could not archive job', e instanceof Error ? e.message : 'The job could not be archived. Please try again.');
              return;
            }
            router.back();
          },
        },
      ],
    );
  }

  const badgeBg = job.status === 'open' ? colors.primaryBgStrong
    : job.status === 'closed' ? '#F1F5F9'
    : colors.accentBg;
  const badgeFg = job.status === 'open' ? colors.primaryText
    : job.status === 'closed' ? '#475569'
    : colors.warning;

  const jobNumberLabel = job.job_number ? `# ${job.job_number}` : 'Pending #';

  return (
    <>
      <Stack.Screen options={{ title: editing ? 'Edit Job' : job.name, headerShown: true }} />
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

          {editing ? (
            <>
              <View style={s.fieldWrap}>
                <FieldLabel>Job Name *</FieldLabel>
                <AppInput
                  value={editName}
                  onChangeText={setEditName}
                  autoFocus
                  placeholder="Job name"
                />
              </View>

              <View style={s.fieldWrap}>
                <FieldLabel>Status</FieldLabel>
                <View style={s.chipRow}>
                  {(['open', 'closed', 'archived'] as const).map(st => (
                    <FilterChip
                      key={st}
                      label={st.charAt(0).toUpperCase() + st.slice(1)}
                      active={editStatus === st}
                      onPress={() => setEditStatus(st)}
                    />
                  ))}
                </View>
              </View>

              {jobTypes.length > 0 && (
                <View style={s.fieldWrap}>
                  <FieldLabel>Type</FieldLabel>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={s.chipRow}
                  >
                    {jobTypes.map(t => (
                      <FilterChip
                        key={t.label}
                        label={`${renderIcon(t.icon)} ${t.label}`}
                        active={editType === t.label}
                        onPress={() => setEditType(prev => prev === t.label ? null : t.label)}
                      />
                    ))}
                  </ScrollView>
                </View>
              )}

              <View style={s.fieldWrap}>
                <FieldLabel>Customer Name</FieldLabel>
                <AppInput
                  value={editCustomerName}
                  onChangeText={setEditCustomerName}
                  placeholder="Customer or company name"
                />
              </View>

              <View style={s.fieldWrap}>
                <FieldLabel>Site Address</FieldLabel>
                <AppInput
                  value={editSiteAddress}
                  onChangeText={setEditSiteAddress}
                  placeholder="Street address or description"
                />
              </View>

              <View style={s.fieldWrap}>
                <FieldLabel>Site Location</FieldLabel>
                <SearchablePicker
                  placeholder="Search locations..."
                  options={locationOptions}
                  value={editSiteLocation}
                  onSelect={opt =>
                    setEditSiteLocation(prev => prev?.id === opt.id ? null : opt)
                  }
                />
              </View>

              <View style={s.fieldWrap}>
                <FieldLabel>Reference # (external)</FieldLabel>
                <AppInput
                  value={editReferenceNumber}
                  onChangeText={setEditReferenceNumber}
                  placeholder="Insurance claim / customer PO #"
                  autoCapitalize="characters"
                />
              </View>

              <View style={s.fieldWrap}>
                <FieldLabel>Insurance carrier</FieldLabel>
                <AppInput
                  value={editInsuranceCarrier}
                  onChangeText={setEditInsuranceCarrier}
                  placeholder="Insurance company"
                />
              </View>

              <View style={s.fieldWrap}>
                <FieldLabel>Description</FieldLabel>
                <AppInput
                  style={s.textArea}
                  value={editDescription}
                  onChangeText={setEditDescription}
                  placeholder="Job description or notes"
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
              </View>

              <View style={s.row}>
                <TouchableOpacity style={[s.btnGhost, { flex: 1 }]} onPress={() => setEditing(false)}>
                  <Text style={s.btnGhostText}>Cancel</Text>
                </TouchableOpacity>
                <PrimaryButton label="Save Changes" onPress={saveEdit} style={{ flex: 1 }} />
              </View>
            </>
          ) : (
            <>
              {/* Header card */}
              <Card variant="detail">
                <View style={s.jobNumberRow}>
                  <Text style={s.jobNumber}>{jobNumberLabel}</Text>
                  {!job.job_number && (
                    <Text style={s.pendingHint}>assigned after sync</Text>
                  )}
                </View>
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

                {!!job.reference_number && (
                  <View style={s.metaRow}>
                    <FieldLabel style={{ minWidth: 60 }}>Ref #</FieldLabel>
                    <Text style={s.metaValue}>{job.reference_number}</Text>
                  </View>
                )}
                {!!job.insurance_carrier && (
                  <View style={s.metaRow}>
                    <FieldLabel style={{ minWidth: 60 }}>Insurer</FieldLabel>
                    <Text style={s.metaValue}>{job.insurance_carrier}</Text>
                  </View>
                )}
                {!!job.customer_name && (
                  <View style={s.metaRow}>
                    <FieldLabel style={{ minWidth: 60 }}>Customer</FieldLabel>
                    <Text style={s.metaValue}>{job.customer_name}</Text>
                  </View>
                )}
                {!!job.site_address && (
                  <View style={s.metaRow}>
                    <FieldLabel style={{ minWidth: 60 }}>Site</FieldLabel>
                    <Text style={s.metaValue}>{job.site_address}</Text>
                  </View>
                )}
                {!!job.site_address && siteCoords && (
                  <View style={s.mapWrap}>
                    <MapDisplay latitude={siteCoords.latitude} longitude={siteCoords.longitude} />
                  </View>
                )}
                {!!job.site_address && !siteCoords && geocodeFailed && (
                  <Text style={s.mapNote}>Couldn't locate this address on the map.</Text>
                )}
                {!!job.description && (
                  <View style={[s.metaRow, { alignItems: 'flex-start' }]}>
                    <FieldLabel style={{ minWidth: 60 }}>Notes</FieldLabel>
                    <Text style={[s.metaValue, { flex: 1 }]}>{job.description}</Text>
                  </View>
                )}
                {!!job.type && (
                  <View style={s.metaRow}>
                    <FieldLabel style={{ minWidth: 60 }}>Type</FieldLabel>
                    <Text style={s.metaValue}>
                      {(() => { const icon = getTypeIcon('job', job.type!); return icon ? `${icon} ${job.type}` : job.type; })()}
                    </Text>
                  </View>
                )}
                <View style={s.metaRow}>
                  <FieldLabel style={{ minWidth: 60 }}>Team</FieldLabel>
                  <Text style={s.metaValue}>{teamName ?? 'Org-wide (everyone)'}</Text>
                </View>
              </Card>

              {/* Team reassignment — org authority (tier >= 3) only */}
              {teamEditing && (
                <Card variant="detail">
                  <FieldLabel>Owning Team</FieldLabel>
                  <Text style={[s.muted, { marginTop: 4, marginBottom: 8 }]}>
                    Clear the team for org-wide (visible to everyone).
                  </Text>
                  <SearchablePicker
                    placeholder="No team (visible to everyone)"
                    options={teamOptions}
                    value={teamPick}
                    onSelect={opt => setTeamPick(prev => prev?.id === opt.id ? null : opt)}
                  />
                  <View style={s.row}>
                    <TouchableOpacity style={[s.btnGhost, { flex: 1 }]} onPress={() => setTeamEditing(false)}>
                      <Text style={s.btnGhostText}>Cancel</Text>
                    </TouchableOpacity>
                    <PrimaryButton label="Save Team" onPress={commitTeam} style={{ flex: 1 }} />
                  </View>
                </Card>
              )}

              {/* Deployed section */}
              <FieldLabel>Deployed</FieldLabel>
              <Card variant="detail">
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
              </Card>

              {/* Activity section */}
              <FieldLabel>Activity</FieldLabel>
              <Card variant="detail">
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
              </Card>

              {/* Photos section */}
              <FieldLabel>Photos</FieldLabel>
              <MediaGallery entityType="job" entityId={id} canUpload={canUpload} />

              {/* Actions */}
              <PrimaryButton label="Request Approval" onPress={() => setApprovalOpen(true)} />
              {(canEdit || canClose) && (
                <PrimaryButton label="Edit Job" onPress={startEdit} />
              )}
              {isOrgAuthority && !teamEditing && (
                <PrimaryButton label="Change Team" onPress={startTeamEdit} />
              )}
              {canEdit && job.status !== 'archived' && (
                <PrimaryButton tone="danger" label="Archive Job" onPress={doArchive} />
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Request Approval (job) ─────────────────────────────────────── */}
      <RequestApprovalSheet
        visible={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        entityType="job"
        entityId={id}
        entityLabel={job.name}
      />
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: colors.textMuted },

  jobNumberRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  jobNumber: { fontSize: 13, fontWeight: '700', color: colors.primaryText },
  pendingHint: { fontSize: 11, color: colors.textMuted },
  name: { fontSize: 22, fontWeight: '700', color: colors.brand },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  statusBadgeText: { fontSize: 13, fontWeight: '700' },
  dateText: { fontSize: 13, color: colors.textMuted },

  metaRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: 10, gap: 8,
  },
  metaValue: { fontSize: 14, color: colors.textPrimary, flexShrink: 1 },
  mapWrap: { marginTop: 10 },
  mapNote: { fontSize: 12, color: colors.textMuted, marginTop: 8, fontStyle: 'italic' },

  divider: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },

  deployRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  deployTag: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  deploySub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  typeBadge: {
    backgroundColor: colors.primaryBgStrong, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  typeBadgeText: { fontSize: 12, fontWeight: '700', color: colors.primaryText },
  typeBadgeItem: { backgroundColor: '#D1FAE5' },
  typeBadgeItemText: { color: '#065F46' },

  logRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12 },
  logAction: {
    fontSize: 14, fontWeight: '600', color: colors.textPrimary, textTransform: 'capitalize',
  },
  logUser: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  logNote: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  logDate: { fontSize: 12, color: colors.textMuted, marginLeft: 12 },

  fieldWrap: { gap: 6 },
  textArea: { height: 100, paddingTop: 12, paddingBottom: 12 },
  chipRow: { flexDirection: 'row', gap: 8 },

  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btnGhost: {
    borderRadius: 12, paddingVertical: 13, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.textDisabled,
  },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
});
