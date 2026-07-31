import type { UserRole } from '../constants/roles';
import type { Layout } from './widgets';

// Per-role starter dashboards (role dashboards §3). PURE data — no DB / native
// imports (this module is on resolve.ts's DB-free unit-test path).
//
// Resolution order (resolveLayoutFor): user preset → role preset (DB) →
// ROLE_DEFAULT_LAYOUTS[role] → DEFAULT_LAYOUT. A role listed here gets a
// tailored code-default dashboard; admin presets still override it.
//
// Notes on the shapes below:
// - Pinned search is NOT a block — DashboardSearch renders above every layout.
// - "Quick actions" = the contextual #144 blocks (vehicle-checkin / past-due /
//   low-stock-catalog); they render nothing unless their condition holds.
// - Nav tiles keep their hub PermissionGate, so a tile a role's permissions
//   don't allow (e.g. `jobs` for a crew without create_jobs) simply hides.
// These are STARTERS — each role gets a live on-device review and one-line
// config tweaks (crew-first rollout order, spec §3).

// Crew group (mitigation_technician, contents_crew, construction_crew,
// carpet_cleaning_crew): fast tiles, my counts, my equipment, quick actions,
// on-call, then role-relevant nav tiles.
const CREW_LAYOUT: Layout = [
  { widget: 'fast-checkout', width: 'half' },
  { widget: 'fast-checkin', width: 'half' },
  // #177: "daily driver" reading order — my counts first, then the crew's
  // marching orders. vehicles-available replaces units-due-service (crews
  // check vehicle availability far more than service due-dates).
  { widget: 'stat-tiles', width: 'full', config: { stats: ['my-checkouts', 'vehicles-available'] } },
  // #160: jobs assigned to me (directly or via my crew) lead the work lists —
  // this is the crew's marching orders for the day.
  { widget: 'work-list', width: 'full', config: { source: 'my-jobs', title: 'My jobs' } },
  { widget: 'work-list', width: 'full', config: { source: 'my-equipment', title: 'My equipment' } },
  { widget: 'vehicle-checkin', width: 'full' },
  { widget: 'past-due', width: 'full' },
  { widget: 'low-stock-catalog', width: 'full' },
  { widget: 'on-call', width: 'full' },
  { widget: 'jobs', width: 'full' },
  { widget: 'vehicles', width: 'half' },
  { widget: 'lockers', width: 'half' },
];

// Tier-2 managers (production_manager, head_of_construction, head_of_contents,
// carpet_cleaning_manager): fast tiles, org-level counts, open jobs, low stock,
// activity, then team/jobs/inventory nav tiles.
const TIER2_MANAGER_LAYOUT: Layout = [
  { widget: 'fast-checkout', width: 'half' },
  { widget: 'fast-checkin', width: 'half' },
  { widget: 'stat-tiles', width: 'full', config: { stats: ['open-jobs', 'open-repairs', 'low-stock', 'units-due-service'] } },
  { widget: 'work-list', width: 'full', config: { source: 'open-jobs', title: 'Open jobs' } },
  { widget: 'low-stock', width: 'full' },
  { widget: 'activity-preview', width: 'full' },
  { widget: 'teams', width: 'full' },
  { widget: 'jobs', width: 'full' },
  { widget: 'equipment', width: 'full' },
  { widget: 'item-catalog', width: 'full' },
  // #165: managers see their team's vehicles/lockers (view inventory, edit
  // state, lock checkout via canManageVehicle).
  { widget: 'vehicles', width: 'half' },
  { widget: 'lockers', width: 'half' },
];

// franchise_manager / full_admin: org counts, activity, quick actions, open
// jobs, then the admin nav tiles.
// Admins keep the ENTIRE default button set (live review 2026-07-20: the first
// widgets-only cut "got rid of all my buttons") — new data widgets layer on top.
const ADMIN_LAYOUT: Layout = [
  { widget: 'stat-tiles', width: 'full', config: { stats: ['open-jobs', 'low-stock', 'open-repairs', 'units-due-service'] } },
  { widget: 'vehicle-checkin', width: 'full' },
  { widget: 'past-due', width: 'full' },
  { widget: 'low-stock-catalog', width: 'full' },
  { widget: 'fast-checkout', width: 'half' },
  { widget: 'fast-checkin', width: 'half' },
  { widget: 'checkout', width: 'full' },
  { widget: 'checkin', width: 'full' },
  { widget: 'my-checkouts', width: 'full' },
  { widget: 'work-list', width: 'full', config: { source: 'open-jobs', title: 'Open jobs' } },
  { widget: 'activity-preview', width: 'full' },
  { widget: 'quick-add', width: 'full' },

  { widget: 'section', width: 'full', config: { sectionTitle: 'Inventory Management' } },
  { widget: 'add-stock', width: 'full' },
  { widget: 'equipment', width: 'full' },
  { widget: 'repairs', width: 'full' },
  { widget: 'locations', width: 'full' },
  { widget: 'vehicles', width: 'half' },
  { widget: 'lockers', width: 'half' },
  { widget: 'item-catalog', width: 'full' },

  { widget: 'section', width: 'full', config: { sectionTitle: 'Operations' } },
  { widget: 'chat', width: 'full' },
  { widget: 'jobs', width: 'full' },
  { widget: 'teams', width: 'full' },
  { widget: 'manage-my-team', width: 'full' },
  { widget: 'media', width: 'full' },
  { widget: 'logs', width: 'full' },

  { widget: 'section', width: 'full', config: { sectionTitle: 'Admin' } },
  { widget: 'users', width: 'full' },
  { widget: 'roles', width: 'full' },
  { widget: 'settings', width: 'full' },

  { widget: 'low-stock', width: 'full' },
  { widget: 'on-call', width: 'full' },
];

export const ROLE_DEFAULT_LAYOUTS: Partial<Record<UserRole, Layout>> = {
  // Crew group.
  mitigation_technician: CREW_LAYOUT,
  contents_crew: CREW_LAYOUT,
  construction_crew: CREW_LAYOUT,
  carpet_cleaning_crew: CREW_LAYOUT,
  duct_cleaning_technician: CREW_LAYOUT,

  // temporary_employee: fast tiles + "My jobs" (#160) + "My equipment" only.
  temporary_employee: [
    { widget: 'fast-checkout', width: 'half' },
    { widget: 'fast-checkin', width: 'half' },
    { widget: 'work-list', width: 'full', config: { source: 'my-jobs', title: 'My jobs' } },
    { widget: 'work-list', width: 'full', config: { source: 'my-equipment', title: 'My equipment' } },
  ],

  // Tier-2 managers.
  production_manager: TIER2_MANAGER_LAYOUT,
  head_of_construction: TIER2_MANAGER_LAYOUT,
  head_of_contents: TIER2_MANAGER_LAYOUT,
  carpet_cleaning_manager: TIER2_MANAGER_LAYOUT,

  // office_manager: jobs + stock counts, open jobs, activity, office nav tiles.
  office_manager: [
    { widget: 'stat-tiles', width: 'full', config: { stats: ['open-jobs', 'low-stock'] } },
    { widget: 'work-list', width: 'full', config: { source: 'open-jobs', title: 'Open jobs' } },
    { widget: 'activity-preview', width: 'full' },
    { widget: 'jobs', width: 'full' },
    { widget: 'item-catalog', width: 'full' },
    { widget: 'locations', width: 'full' },
    { widget: 'logs', width: 'full' },
  ],

  // hr_manager: people-centric — headcount, activity, users/teams/logs.
  hr_manager: [
    { widget: 'stat-tiles', width: 'full', config: { stats: ['team-members'] } },
    { widget: 'activity-preview', width: 'full' },
    { widget: 'users', width: 'full' },
    { widget: 'teams', width: 'full' },
    { widget: 'logs', width: 'full' },
  ],

  // Top tier.
  franchise_manager: ADMIN_LAYOUT,
  full_admin: ADMIN_LAYOUT,
};
