import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getJobById, getJobDeployments, archiveJob, updateJobFields, Job,
} from '../../../src/db/queries/jobs';
import { getLogForJob, appendLog, LogEntry } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { getAllLocations, resolveLocationShelfSelection } from '../../../src/db/queries/locations';
import { getAllTeams } from '../../../src/db/queries/teams';
import {
  getAssignmentsForJob, getAssignableCrews, assignJobToCrew, assignJobToUser, unassign,
  JobAssignmentView,
} from '../../../src/db/queries/jobAssignments';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { getTaxonomyTypesWithFallback } from '../../../src/db/queries/taxonomy';
import { JobSummaryCard } from '../../../src/components/jobs/JobSummaryCard';
import { ROLE_TIER } from '../../../src/constants/roles';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { LocationShelfPicker, TaxonomyChips } from '../../../src/components/pickers';
import { MediaGallery } from '../../../src/components/MediaGallery';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { Card } from '../../../src/components/ui/Card';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { SegmentedControl } from '../../../src/components/ui/SegmentedControl';
import { AutofillTextField } from '../../../src/components/ui/AutofillTextField';
import { RequestApprovalSheet } from '../../../src/components/RequestApprovalSheet';
import { track } from '../../../src/telemetry';
import { validateName, validateText } from '../../../src/lib/validation';

type LogWithUser = LogEntry & { user_name?: string };

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'job_detail', props: { field, rule } });
}

export default function JobDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const canEdit = usePermission('create_jobs');
  const canClose = usePermission('close_jobs');
  const canUpload = usePermission('upload_media');
  const refreshKey = useFocusOrDataRefresh();

  const [job, setJob] = useState<Job | null>(() => getJobById(id));
  const [editing, setEditing] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);

  // Re-read the job row on refocus or when a sync pull applies changes — the row
  // is useState so own edits can reload() it synchronously, but synced changes
  // must land too. The edit-form buffers below stay one-shot (seeded only in
  // startEdit), so an in-progress edit is never clobbered by this re-read.
  useEffect(() => {
    setJob(getJobById(id));
  }, [id, refreshKey]);

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState<string>('');
  const [editCustomerName, setEditCustomerName] = useState('');
  const [editSiteAddress, setEditSiteAddress] = useState('');
  const [editSiteLocation, setEditSiteLocation] = useState<PickerOption | null>(null);
  const [editSiteShelf, setEditSiteShelf] = useState<PickerOption | null>(null);
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

  // Team-change flow (org authority only), kept out of the generic edit form so a
  // tier-2 create_jobs editor can't reassign teams.
  const [teamEditing, setTeamEditing] = useState(false);
  const [teamPick, setTeamPick] = useState<PickerOption | null>(null);

  // Assigned crews (#160) — jobs are assigned to a SUBTEAM (crew) or an
  // individual user; helpers resolve at read time from team_members, so
  // assigning a crew covers its whole current roster. Gated on create_jobs
  // (the same permission the server's sync push requires for these writes).
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignKind, setAssignKind] = useState<'crew' | 'user'>('crew');
  // Own writes bump this so the section refreshes immediately (refreshKey also
  // covers synced changes from other devices).
  const [assignBump, setAssignBump] = useState(0);
  const assignments = useMemo<JobAssignmentView[]>(
    () => (canEdit ? getAssignmentsForJob(id) : []),
    [id, refreshKey, assignBump, canEdit],
  );
  // Offer only not-yet-assigned crews/users (re-assign is an idempotent no-op
  // anyway, but hiding them keeps the picker honest).
  const assignedIds = useMemo(() => new Set(assignments.map(a => a.assignee_id)), [assignments]);
  const crewOptions = useMemo(
    () => (canEdit ? getAssignableCrews().filter(c => !assignedIds.has(c.id)) : []),
    [refreshKey, assignBump, canEdit, assignedIds],
  );
  const userOptions = useMemo(
    () => (canEdit ? getAllActiveUsers().filter(u => !assignedIds.has(u.id)) : []),
    [refreshKey, assignBump, canEdit, assignedIds],
  );

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
    setEditSiteShelf(null);
    setEditing(true);
  }

  function saveEdit() {
    // Bounded, control-char-free name (same 'Job name is required.' copy as
    // before for the blank case).
    const nameResult = validateName(editName, { label: 'Job name' });
    if (!nameResult.ok) { trackReject('job.name', nameResult.rule); Alert.alert('Required', nameResult.error); return; }
    const trimmed = nameResult.value;
    if (!user) { Alert.alert('Error', 'Not logged in.'); return; }

    // Optional free text: bounded + control-char-rejecting, checked BEFORE any
    // local write. Blank stays fine (→ null below, as before).
    const textChecks = [
      { field: 'job.customer_name', value: editCustomerName, label: 'Customer name', max: 200 },
      { field: 'job.site_address', value: editSiteAddress, label: 'Site address', max: 500 },
      { field: 'job.reference_number', value: editReferenceNumber, label: 'Reference #', max: 100 },
      { field: 'job.insurance_carrier', value: editInsuranceCarrier, label: 'Insurance carrier', max: 200 },
      { field: 'job.description', value: editDescription, label: 'Description', max: 2000 },
    ] as const;
    for (const c of textChecks) {
      const r = validateText(c.value, { label: c.label, max: c.max });
      if (!r.ok) { trackReject(c.field, r.rule); Alert.alert(`Check ${c.label.toLowerCase()}`, r.error); return; }
    }

    // Resolve the site location (may create a new shelf under the picked
    // location); a typed-in shelf that can't be created stops the save.
    const locRes = resolveLocationShelfSelection(editSiteLocation, editSiteShelf);
    if (!locRes.ok) {
      Alert.alert('Could not create shelf', `Could not create shelf "${locRes.shelfLabel}". Please re-pick or re-enter it.`);
      return;
    }

    const fields = {
      name: trimmed,
      status: editStatus,
      customer_name: editCustomerName.trim() || null,
      site_address: editSiteAddress.trim() || null,
      site_location_id: locRes.id,
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

  function doAssign(kind: 'crew' | 'user', assigneeId: string, label: string) {
    if (!user) { Alert.alert('Error', 'Not logged in.'); return; }
    // The query layer commits the assignment row, its outbox entry, and the
    // audit log atomically (jobAssignments.ts); re-picking an already-active
    // assignee is an idempotent no-op.
    try {
      if (kind === 'crew') assignJobToCrew(id, assigneeId, user.id);
      else assignJobToUser(id, assigneeId, user.id);
    } catch (e) {
      Alert.alert('Could not assign', e instanceof Error ? e.message : `${label} could not be assigned. Please try again.`);
      return;
    }
    setAssignOpen(false);
    setAssignBump(b => b + 1);
  }

  function doUnassign(a: JobAssignmentView) {
    if (!user) { Alert.alert('Error', 'Not logged in.'); return; }
    Alert.alert(
      'Remove assignment',
      `Remove ${a.assignee_name} from "${job!.name}"?${a.assignee_kind === 'subteam' ? ' The whole crew loses this job from "My jobs".' : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: () => {
            try {
              unassign(a.id, user.id);
            } catch (e) {
              Alert.alert('Could not remove', e instanceof Error ? e.message : 'The assignment could not be removed. Please try again.');
              return;
            }
            setAssignBump(b => b + 1);
          },
        },
      ],
    );
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


  return (
    <>
      <Stack.Screen options={{ title: editing ? 'Edit Job' : job.name, headerShown: true }} />
      <FormScreen contentContainerStyle={s.content}>

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
                  <TaxonomyChips
                    category="job"
                    label="Type"
                    withFallback
                    deselectable
                    valueLabel={editType}
                    onChange={v => setEditType(v.label)}
                  />
                </View>
              )}

              <AutofillTextField
                label="Customer Name"
                table="jobs"
                column="customer_name"
                value={editCustomerName}
                onChangeText={setEditCustomerName}
                placeholder="Customer or company name"
              />

              <AutofillTextField
                label="Site Address"
                table="jobs"
                column="site_address"
                value={editSiteAddress}
                onChangeText={setEditSiteAddress}
                placeholder="Street address or description"
              />

              <LocationShelfPicker
                locationValue={editSiteLocation}
                shelfValue={editSiteShelf}
                onChangeLocation={setEditSiteLocation}
                onChangeShelf={setEditSiteShelf}
              />

              <View style={s.fieldWrap}>
                <FieldLabel>Reference # (external)</FieldLabel>
                <AppInput
                  value={editReferenceNumber}
                  onChangeText={setEditReferenceNumber}
                  placeholder="Insurance claim / customer PO #"
                  autoCapitalize="characters"
                />
              </View>

              <AutofillTextField
                label="Insurance carrier"
                table="jobs"
                column="insurance_carrier"
                value={editInsuranceCarrier}
                onChangeText={setEditInsuranceCarrier}
                placeholder="Insurance company"
              />

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
              {/* Header card (#184: extracted to JobSummaryCard — reused by the
                  schedule board's JobDetailPopup) */}
              <JobSummaryCard job={job} />

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

              {/* Assigned crews (#160) — create_jobs gated (mirrors the server's
                  sync-push gate on job_assignments writes) */}
              {canEdit && (
                <>
                  <FieldLabel>Assigned Crews</FieldLabel>
                  <Card variant="detail">
                    {assignments.length === 0 ? (
                      <Text style={s.muted}>No crews or users assigned.</Text>
                    ) : (
                      assignments.map((a, i) => (
                        <View key={a.id} style={[s.deployRow, i < assignments.length - 1 && s.divider]}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.deployTag}>{a.assignee_name}</Text>
                            <Text style={s.deploySub}>
                              {a.assignee_kind === 'subteam' ? 'Crew · members resolve automatically' : 'Individual'}
                            </Text>
                          </View>
                          <TouchableOpacity onPress={() => doUnassign(a)} hitSlop={8}>
                            <Text style={s.removeText}>Remove</Text>
                          </TouchableOpacity>
                        </View>
                      ))
                    )}
                    <TouchableOpacity
                      style={s.assignBtn}
                      onPress={() => { setAssignKind('crew'); setAssignOpen(true); }}
                    >
                      <Text style={s.assignBtnText}>+ Assign crew or user</Text>
                    </TouchableOpacity>
                  </Card>
                </>
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
      </FormScreen>

      {/* ── Assign crew/user (#160) ────────────────────────────────────── */}
      {canEdit && (
        <ModalSheet visible={assignOpen} onClose={() => setAssignOpen(false)} scroll>
          <Text style={s.sheetTitle}>Assign “{job.name}”</Text>
          <SegmentedControl
            segments={[{ id: 'crew', label: 'Crews' }, { id: 'user', label: 'Individuals' }]}
            value={assignKind}
            onChange={k => setAssignKind(k as 'crew' | 'user')}
          />
          {assignKind === 'crew' ? (
            crewOptions.length === 0 ? (
              <Text style={[s.muted, s.sheetEmpty]}>No unassigned crews.</Text>
            ) : (
              crewOptions.map((c, i) => (
                <TouchableOpacity
                  key={c.id}
                  style={[s.optionRow, i < crewOptions.length - 1 && s.divider]}
                  onPress={() => doAssign('crew', c.id, c.name)}
                >
                  <Text style={s.deployTag}>{c.name}</Text>
                  <Text style={s.deploySub}>
                    {[c.team_name, c.lead_name ? `Lead: ${c.lead_name}` : null].filter(Boolean).join(' · ') || 'Crew'}
                  </Text>
                </TouchableOpacity>
              ))
            )
          ) : (
            userOptions.length === 0 ? (
              <Text style={[s.muted, s.sheetEmpty]}>No unassigned users.</Text>
            ) : (
              userOptions.map((u, i) => (
                <TouchableOpacity
                  key={u.id}
                  style={[s.optionRow, i < userOptions.length - 1 && s.divider]}
                  onPress={() => doAssign('user', u.id, u.name)}
                >
                  <Text style={s.deployTag}>{u.name}</Text>
                  <Text style={s.deploySub}>{u.role.replace(/_/g, ' ')}</Text>
                </TouchableOpacity>
              ))
            )
          )}
        </ModalSheet>
      )}

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

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: t.colors.textMuted },

  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },

  deployRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  deployTag: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  deploySub: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  typeBadge: {
    backgroundColor: t.colors.primaryBgStrong, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  typeBadgeText: { fontSize: 12, fontWeight: '700', color: t.colors.primaryText },
  typeBadgeItem: { backgroundColor: t.colors.successBg },
  typeBadgeItemText: { color: t.colors.successText },

  // Assigned crews (#160)
  removeText: { fontSize: 13, fontWeight: '600', color: t.colors.danger, marginLeft: 12 },
  assignBtn: { marginTop: 10, alignSelf: 'flex-start' },
  assignBtnText: { fontSize: 14, fontWeight: '600', color: t.colors.primary },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 12 },
  sheetEmpty: { marginTop: 16 },
  optionRow: { paddingVertical: 12 },

  logRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12 },
  logAction: {
    fontSize: 14, fontWeight: '600', color: t.colors.textPrimary, textTransform: 'capitalize',
  },
  logUser: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  logNote: { fontSize: 12, color: t.colors.textMuted, marginTop: 2 },
  logDate: { fontSize: 12, color: t.colors.textMuted, marginLeft: 12 },

  fieldWrap: { gap: 6 },
  textArea: { height: 100, paddingTop: 12, paddingBottom: 12 },
  chipRow: { flexDirection: 'row', gap: 8 },

  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btnGhost: {
    borderRadius: 12, paddingVertical: 13, alignItems: 'center',
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.textDisabled,
  },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
});
