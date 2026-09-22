import { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import * as Location from 'expo-location';
import type { Job } from '../../repos/jobs';
import { getTeamById } from '../../repos/teams';
import { getTypeIcon } from '../../repos/taxonomy';
import { Card, FieldLabel, useThemedStyles, useTheme, type Theme } from '@invenpro/ui';
import { MapDisplay } from '../MapDisplay';

interface Props {
  job: Job;
}

// Ported from apps/mobile/src/components/jobs/JobSummaryCard.tsx (154 ln) — a
// straight port, no cuts (MapDisplay + expo-location both already exist in
// mobile-v2). Extracted in the old app so a future schedule-board popup could
// reuse the same job-summary content (kit rule: grow/reuse, never duplicate a
// surface) — jobs/[id].tsx below is the only consumer this wave.
export function JobSummaryCard({ job }: Props) {
  const s = useThemedStyles(makeStyles);
  const [siteCoords, setSiteCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [geocodeFailed, setGeocodeFailed] = useState(false);

  const siteAddress = job.site_address ?? null;
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

  const teamName = job.team_id ? (getTeamById(job.team_id)?.name ?? 'Assigned team') : null;
  const t = useTheme();
  const badgeBg = job.status === 'open' ? t.colors.primaryBgStrong
    : job.status === 'closed' ? t.colors.surfaceAlt
    : t.colors.accentBg;
  const badgeFg = job.status === 'open' ? t.colors.primaryText
    : job.status === 'closed' ? '#475569'
    : t.colors.warning;

  return (
    <Card variant="detail">
      <View style={s.jobNumberRow}>
        <Text style={s.jobNumber}>{job.job_number ? `# ${job.job_number}` : 'Pending #'}</Text>
        {!job.job_number && <Text style={s.pendingHint}>assigned after sync</Text>}
      </View>
      <Text style={s.name}>{job.name}</Text>
      <View style={s.headerRow}>
        <View style={[s.statusBadge, { backgroundColor: badgeBg }]}>
          <Text style={[s.statusBadgeText, { color: badgeFg }]}>
            {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
          </Text>
        </View>
        <Text style={s.dateText}>Created {new Date(job.created_at).toLocaleDateString()}</Text>
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
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  jobNumberRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  jobNumber: { fontSize: 13, fontWeight: '700', color: t.colors.primaryText },
  pendingHint: { fontSize: 11, color: t.colors.textMuted },
  name: { fontSize: 22, fontWeight: '700', color: t.colors.brand },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: t.colors.primaryBgStrong },
  statusBadgeText: { fontSize: 13, fontWeight: '700', color: t.colors.primaryText },
  dateText: { fontSize: 13, color: t.colors.textMuted },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 8 },
  metaValue: { fontSize: 14, color: t.colors.textPrimary, flexShrink: 1 },
  mapWrap: { marginTop: 10 },
  mapNote: { fontSize: 12, color: t.colors.textMuted, marginTop: 8, fontStyle: 'italic' },
});
