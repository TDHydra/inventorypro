import { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import * as Location from 'expo-location';
import type { Job } from '../../db/queries/jobs';
import { getTeamById } from '../../db/queries/teams';
import { getTypeIcon } from '../../db/queries/taxonomy';
import { Card } from '../ui/Card';
import { FieldLabel } from '../ui/FieldLabel';
import { MapDisplay } from '../MapDisplay';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import type { Theme } from '../../themes/types';

interface Props {
  job: Job;
}

// #184: extracted from app/(app)/(jobs)/[id].tsx so the schedule board's
// JobDetailPopup renders the exact same job-summary content — one source of
// truth, no forked copy (kit rule: grow/reuse, never duplicate a surface).
// Owns its own site-address geocoding so any consumer gets the map for free.
export function JobSummaryCard({ job }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const [siteCoords, setSiteCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [geocodeFailed, setGeocodeFailed] = useState(false);

  // Geocode the free-text site address (online, no API key) so we can show a
  // view-only map. Failures/empties are swallowed — the map just doesn't appear.
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

  const badgeBg = job.status === 'open' ? t.colors.primaryBgStrong
    : job.status === 'closed' ? t.colors.surfaceAlt
    : t.colors.accentBg;
  const badgeFg = job.status === 'open' ? t.colors.primaryText
    : job.status === 'closed' ? '#475569'
    : t.colors.warning;

  const jobNumberLabel = job.job_number ? `# ${job.job_number}` : 'Pending #';

  return (
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
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  jobNumberRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  jobNumber: { fontSize: 13, fontWeight: '700', color: t.colors.primaryText },
  pendingHint: { fontSize: 11, color: t.colors.textMuted },
  name: { fontSize: 22, fontWeight: '700', color: t.colors.brand },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  statusBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  statusBadgeText: { fontSize: 13, fontWeight: '700' },
  dateText: { fontSize: 13, color: t.colors.textMuted },

  metaRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: 10, gap: 8,
  },
  metaValue: { fontSize: 14, color: t.colors.textPrimary, flexShrink: 1 },
  mapWrap: { marginTop: 10 },
  mapNote: { fontSize: 12, color: t.colors.textMuted, marginTop: 8, fontStyle: 'italic' },
});
