// Station D3: role-dashboard work lists — short "needs my attention" sections
// on the hub. One <WorkList list={id}/> per id in the role's layout (see
// src/dashboard/presets.ts). A list with no rows renders NOTHING (no empty
// state) — the hub is a launchpad, not a status report; absence of a section
// means nothing needs you there, same behavior as the old dashboard widgets.
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useDbQuery } from '@invenpro/core';
import { WorkListId } from '../../dashboard/presets';
import { useSession } from '../../hooks/useSession';
import { UserSession } from '../../auth/permissions';
import { getMyAssignedJobs, getOpenJobs } from '../../repos/jobs';
import { getScheduleAssignmentsForEmployee } from '../../repos/schedule';
import { localTodayIso, formatMinute } from '../schedule/dayMath';
import { listConversations } from '../../repos/chat';
import { getDeployedUnitsForUser, getUnitsStrandedOnClosedJobs } from '../../repos/equipmentUnits';

/** Rows are capped; the header tap goes to the full surface. */
const MAX_ROWS = 5;

interface WorkRow {
  id: string;
  label: string;
  sub: string | null;
  href: Href;
}

interface WorkListDef {
  title: string;
  /** Where the header (and the "+N more" footer) navigates. */
  href: Href;
  tables: string[];
  query: (user: UserSession) => WorkRow[];
}

const jobSub = (j: { job_number?: string | null; customer_name?: string | null }): string | null => {
  const parts = [j.job_number ? `#${j.job_number}` : null, j.customer_name ?? null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
};

const LIST_DEFS: Record<WorkListId, WorkListDef> = {
  'my-schedule-today': {
    title: "Today's Schedule",
    href: '/(app)/schedule',
    tables: ['schedule_assignments', 'jobs', 'users'],
    query: u => getScheduleAssignmentsForEmployee(u.id, localTodayIso()).map(a => ({
      id: a.id,
      label: a.assignment_kind === 'job'
        ? (a.job_name ?? 'Job')
        : `See ${a.manager_name ?? 'manager'}`,
      sub: `${formatMinute(a.start_minute)} – ${formatMinute(a.end_minute)}`,
      href: '/(app)/schedule',
    })),
  },
  'unread-chats': {
    title: 'Unread Messages',
    href: '/(app)/chat',
    tables: ['conversations', 'conversation_participants', 'messages', 'users'],
    query: u => listConversations(u.id).filter(c => c.unread > 0).map(c => ({
      id: c.id,
      label: c.title ?? c.peer_name ?? 'Conversation',
      sub: c.last_body,
      href: { pathname: '/(app)/chat/[id]', params: { id: c.id } } as Href,
    })),
  },
  'my-jobs': {
    title: 'My Jobs',
    href: '/(app)/jobs',
    tables: ['jobs', 'job_assignments', 'team_members'],
    query: u => getMyAssignedJobs(u.id).map(j => ({
      id: j.id,
      label: j.name,
      sub: jobSub(j),
      href: { pathname: '/(app)/jobs/[id]', params: { id: j.id } } as Href,
    })),
  },
  // Equipment detail routes by ITEM id (equipment/[id].tsx is the item page;
  // its units panel covers the specific unit) — same convention as scan.tsx.
  'my-equipment': {
    title: 'My Equipment Out',
    href: '/(app)/equipment',
    tables: ['equipment_units', 'inventory_items', 'jobs', 'activity_log'],
    query: u => getDeployedUnitsForUser(u.id).map(eu => ({
      id: eu.id,
      label: `${eu.asset_tag} · ${eu.item_name}`,
      sub: eu.job_name ? `On ${eu.job_name}` : null,
      href: { pathname: '/(app)/equipment/[id]', params: { id: eu.item_id } } as Href,
    })),
  },
  'open-jobs': {
    title: 'Open Jobs',
    href: '/(app)/jobs',
    tables: ['jobs'],
    query: () => getOpenJobs().map(j => ({
      id: j.id,
      label: j.name,
      sub: jobSub(j),
      href: { pathname: '/(app)/jobs/[id]', params: { id: j.id } } as Href,
    })),
  },
  // #223 recovery list: deployed units whose job has since closed.
  'stranded-equipment': {
    title: 'Equipment on Closed Jobs',
    href: '/(app)/equipment',
    tables: ['equipment_units', 'inventory_items', 'jobs'],
    query: () => getUnitsStrandedOnClosedJobs().map(eu => ({
      id: eu.id,
      label: `${eu.asset_tag} · ${eu.item_name}`,
      sub: `Job closed: ${eu.job_name}`,
      href: { pathname: '/(app)/equipment/[id]', params: { id: eu.item_id } } as Href,
    })),
  },
};

export function WorkList({ list }: { list: WorkListId }) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const def = LIST_DEFS[list];

  const rows = useDbQuery(
    () => {
      if (!user) return [];
      try {
        return def.query(user);
      } catch {
        return [];
      }
    },
    [user?.id, list],
    def.tables,
  );

  if (!user || !rows || rows.length === 0) return null;

  return (
    <View style={styles.card}>
      <TouchableOpacity onPress={() => router.push(def.href)}>
        <Text style={styles.title}>{def.title}</Text>
      </TouchableOpacity>
      {rows.slice(0, MAX_ROWS).map(row => (
        <TouchableOpacity key={row.id} style={styles.row} onPress={() => router.push(row.href)}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel} numberOfLines={1}>{row.label}</Text>
            {row.sub != null && row.sub !== '' && (
              <Text style={styles.rowSub} numberOfLines={1}>{row.sub}</Text>
            )}
          </View>
          <Text style={styles.chevron}>›</Text>
        </TouchableOpacity>
      ))}
      {rows.length > MAX_ROWS && (
        <TouchableOpacity onPress={() => router.push(def.href)}>
          <Text style={styles.more}>+{rows.length - MAX_ROWS} more →</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  card: {
    backgroundColor: t.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.colors.border,
    padding: 14,
    marginBottom: 16,
  },
  title: { fontSize: 14, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.colors.border,
  },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: t.colors.textPrimary },
  rowSub: { fontSize: 12, color: t.colors.textSecondary, marginTop: 1 },
  chevron: { fontSize: 18, color: t.colors.textSecondary, paddingLeft: 8 },
  more: { fontSize: 13, fontWeight: '600', color: t.colors.primaryText, paddingTop: 8 },
});
