import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { LogEntry, LogNameMaps, resolveEntityName } from '../db/queries/log';
import { colors } from '../theme';

// ── metadata parsing ───────────────────────────────────────────────────────────
// activity_log.metadata is a JSON string (or null). We render it as a readable
// what-changed block: keys that carry a { before/after | old/new | from/to } pair
// become a "old → new" diff line; everything else becomes a plain key/value line.

type DiffPair = { before: unknown; after: unknown };

function asDiffPair(v: unknown): DiffPair | null {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if ('before' in o || 'after' in o) return { before: o.before, after: o.after };
  if ('old' in o || 'new' in o) return { before: o.old, after: o.new };
  if ('from' in o || 'to' in o) return { before: o.from, after: o.to };
  return null;
}

/** Humanise a metadata key: snake/camel → spaced words, dropping an _id suffix. */
function humanKey(key: string): string {
  return key
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function displayValue(v: unknown, maps: LogNameMaps): string {
  if (v == null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  // Best-effort: if the value is an id we happen to know a name for, show the name.
  return maps.users[s] ?? maps.teams[s] ?? maps.jobs[s] ?? maps.locations[s] ?? s;
}

interface MetaLine {
  key: string;
  before?: string;
  after?: string;
  value?: string;
}

function parseMetadata(raw: string | null, maps: LogNameMaps): MetaLine[] | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Not JSON — surface the raw string as a single line rather than dropping it.
    return [{ key: 'detail', value: raw }];
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return [{ key: 'detail', value: displayValue(obj, maps) }];
  }
  // A top-level before/after diff (e.g. { before: {...}, after: {...} }).
  const topPair = asDiffPair(obj);
  if (topPair) {
    return [{ key: 'change', before: displayValue(topPair.before, maps), after: displayValue(topPair.after, maps) }];
  }
  const lines: MetaLine[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const pair = asDiffPair(v);
    if (pair) {
      lines.push({ key: humanKey(k), before: displayValue(pair.before, maps), after: displayValue(pair.after, maps) });
    } else {
      lines.push({ key: humanKey(k), value: displayValue(v, maps) });
    }
  }
  return lines.length > 0 ? lines : null;
}

// ── component ──────────────────────────────────────────────────────────────────

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.statRow}>
      <Text style={s.statKey}>{k}</Text>
      <Text style={s.statVal} numberOfLines={2}>{v}</Text>
    </View>
  );
}

interface Props {
  log: LogEntry;
  nameMaps: LogNameMaps;
  /** Opens the map modal for rows that carry stamped coordinates. */
  onViewMap?: () => void;
}

/**
 * Expanded what-changed view for one activity_log row: resolves actor / team /
 * job / from→to locations / entity to human names, formats the parsed metadata
 * (before→after diffs where present) + note, and surfaces coordinates.
 */
export function ActivityLogDetail({ log, nameMaps, onViewMap }: Props) {
  const actor = log.user_name ?? (log.user_id ? nameMaps.users[log.user_id] : null);
  const team = log.team_id ? nameMaps.teams[log.team_id] : null;
  const job = log.job_id ? nameMaps.jobs[log.job_id] : null;
  const fromLoc = log.from_location_id ? nameMaps.locations[log.from_location_id] : null;
  const toLoc = log.to_location_id ? nameMaps.locations[log.to_location_id] : null;
  const entity = resolveEntityName(nameMaps, log.entity_type, log.entity_id);
  const meta = parseMetadata(log.metadata, nameMaps);
  const hasCoords = log.latitude != null && log.longitude != null;

  return (
    <View style={s.wrap}>
      <View style={s.stats}>
        {actor && <Stat k="Actor" v={actor} />}
        {log.entity_type ? (
          <Stat k="Entity" v={entity ? `${log.entity_type} · ${entity}` : log.entity_type} />
        ) : null}
        {team && <Stat k="Team" v={team} />}
        {job && <Stat k="Job" v={job} />}
        {log.quantity != null && log.unit ? (
          <Stat k="Quantity" v={`${log.quantity} ${log.unit}`} />
        ) : null}
        {(fromLoc || toLoc) ? (
          <Stat k="Location" v={fromLoc && toLoc ? `${fromLoc} → ${toLoc}` : (toLoc ?? fromLoc ?? '')} />
        ) : null}
        <Stat k="When" v={new Date(log.created_at).toLocaleString()} />
      </View>

      {meta && (
        <>
          <Text style={s.sectionLabel}>Changes</Text>
          <View style={s.metaBox}>
            {meta.map((m, i) => (
              <View key={i} style={s.metaRow}>
                <Text style={s.metaKey}>{m.key}</Text>
                {m.before !== undefined || m.after !== undefined ? (
                  <Text style={s.metaVal} numberOfLines={3}>
                    <Text style={s.metaOld}>{m.before ?? '—'}</Text>
                    <Text style={s.metaArrow}>{'  →  '}</Text>
                    <Text style={s.metaNew}>{m.after ?? '—'}</Text>
                  </Text>
                ) : (
                  <Text style={s.metaVal} numberOfLines={3}>{m.value}</Text>
                )}
              </View>
            ))}
          </View>
        </>
      )}

      {log.note ? (
        <>
          <Text style={s.sectionLabel}>Note</Text>
          <Text style={s.note}>{log.note}</Text>
        </>
      ) : null}

      {hasCoords && (
        <TouchableOpacity style={s.mapBtn} onPress={onViewMap}>
          <Text style={s.mapBtnText}>📍 View on map</Text>
          {log.location_accuracy != null && (
            <Text style={s.mapAccuracy}>±{Math.round(log.location_accuracy)}m</Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    borderTopWidth: 1,
    borderTopColor: colors.borderDetail,
    marginTop: 10,
    paddingTop: 10,
    gap: 6,
  },
  stats: {
    backgroundColor: colors.background,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 2,
  },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 2 },
  statKey: { fontSize: 12, color: colors.textMuted },
  statVal: { fontSize: 12, fontWeight: '600', color: '#334155', flexShrink: 1, marginLeft: 12, textAlign: 'right' },

  sectionLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginTop: 4 },
  metaBox: { gap: 4 },
  metaRow: { gap: 1 },
  metaKey: { fontSize: 11, color: colors.textMuted, textTransform: 'capitalize' },
  metaVal: { fontSize: 13, color: '#334155' },
  metaOld: { color: colors.danger },
  metaArrow: { color: colors.textMuted },
  metaNew: { color: colors.success, fontWeight: '600' },

  note: { fontSize: 13, color: colors.textSecondary },

  mapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingVertical: 4,
  },
  mapBtnText: { fontSize: 13, color: colors.primaryText, fontWeight: '600' },
  mapAccuracy: { fontSize: 11, color: colors.textMuted },
});
