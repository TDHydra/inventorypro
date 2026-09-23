// Station D3: hardcoded per-role dashboards — the plan's replacement for the
// old app's dashboard preset ENGINE (21 files: user-editable layouts, starred
// widgets, a widget registry, dashboard_presets sync). v2 keeps only the
// DEFAULTS as pure data, transcribed from the old src/dashboard/roleLayouts.ts
// role→layout mapping; per-user customization was cut (plan decision #3).
// Pure module (no React/DB imports) so the role coverage test runs in plain
// node — same discipline as ./quickActions.ts.
import { UserRole } from '../constants/roles';

// Vocabulary is intentionally CLOSED: a tile/list only exists here if a v2
// repo feed for it exists (see src/components/dashboard/*). Adding an id
// means adding its def there too — the components exhaust these unions.
export type StatTileId =
  | 'my-checkouts'
  | 'vehicles-available'
  | 'shared-media'
  | 'scheduled-today'
  | 'open-jobs'
  | 'open-repairs'
  | 'low-stock'
  | 'team-members';

export type WorkListId =
  | 'my-schedule-today'
  | 'unread-chats'
  | 'my-jobs'
  | 'my-equipment'
  | 'open-jobs'
  | 'stranded-equipment';

export interface RoleDashboard {
  /** Contextual quick-action pills (vehicle check-in/out, gas receipt, …). */
  quickActions: boolean;
  stats: StatTileId[];
  lists: WorkListId[];
}

// Field crew: "my day" — what I have out, what's free to grab, where I'm
// scheduled. Quick actions on (the old CREW_LAYOUT was the only one that
// carried the quick-actions widget).
const CREW: RoleDashboard = {
  quickActions: true,
  stats: ['my-checkouts', 'vehicles-available', 'shared-media'],
  lists: ['my-schedule-today', 'unread-chats', 'my-jobs', 'my-equipment'],
};

// Tier-2 production managers: the day's operation — board coverage, open
// work, and the recovery list for gear stranded on closed jobs.
const TIER2_MANAGER: RoleDashboard = {
  quickActions: false,
  stats: ['scheduled-today', 'open-jobs', 'open-repairs', 'low-stock', 'shared-media'],
  lists: ['stranded-equipment', 'unread-chats', 'open-jobs'],
};

const ADMIN: RoleDashboard = {
  quickActions: false,
  stats: ['scheduled-today', 'open-jobs', 'low-stock', 'open-repairs', 'shared-media'],
  lists: ['stranded-equipment', 'unread-chats', 'open-jobs'],
};

export const ROLE_DASHBOARDS: Record<UserRole, RoleDashboard> = {
  mitigation_technician:    CREW,
  contents_crew:            CREW,
  construction_crew:        CREW,
  carpet_cleaning_crew:     CREW,
  duct_cleaning_technician: CREW,
  // Temps get the crew view minus checkout/vehicle affordances they don't
  // hold permissions for (old roleLayouts gave them the slimmest layout).
  temporary_employee: {
    quickActions: false,
    stats: ['shared-media'],
    lists: ['my-schedule-today', 'my-jobs', 'my-equipment'],
  },
  production_manager:       TIER2_MANAGER,
  head_of_construction:     TIER2_MANAGER,
  head_of_contents:         TIER2_MANAGER,
  carpet_cleaning_manager:  TIER2_MANAGER,
  office_manager: {
    quickActions: false,
    stats: ['open-jobs', 'low-stock', 'shared-media'],
    lists: ['open-jobs'],
  },
  hr_manager: {
    quickActions: false,
    stats: ['team-members', 'shared-media'],
    lists: [],
  },
  franchise_manager:        ADMIN,
  full_admin:               ADMIN,
};
