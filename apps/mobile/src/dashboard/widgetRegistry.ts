import type { Permission } from '../constants/roles';

// Configurable dashboard foundation (Wave B / D1). A dashboard is a Layout: an
// ordered list of blocks. Each block references a WidgetType in WIDGET_REGISTRY,
// which carries the widget's presentation (label/icon), navigation target (route),
// and — critically — the SAME permission the tile is gated by on today's hub. The
// hub wraps every tile in <PermissionGate permission={registry.requiredPermission}>
// so a preset can NEVER surface a tile the user isn't authorized for.
//
// `tile` widgets are the tappable action cards; `block` widgets are the non-tile
// regions (pinned search, quick-add CTA, section header, low-stock list). Block
// widgets carry no requiredPermission (search/quick-add/low-stock render as they do
// today; QuickAddBanner self-gates internally).
//
// This module holds ONLY the registry (data) + its types — no layout composition.
// It exists as its own file (rather than living in widgets.ts, which composes
// DEFAULT_LAYOUT) so bundles.ts can depend on the registry without widgets.ts and
// bundles.ts importing each other (see widgets.ts's top comment for the layering).

// NOTE (role dashboards): 'search' is no longer a widget — DashboardSearch is
// pinned by the dashboard screen above the resolved layout. Old presets that
// still contain a `search` block parse fine (isWidgetType drops it, so it's
// skipped rather than rendered twice).
export type WidgetType =
  | 'fast-checkout' | 'fast-checkin' | 'scan' | 'checkout' | 'checkin' | 'my-checkouts'
  | 'add-stock' | 'equipment' | 'repairs' | 'locations' | 'item-catalog' | 'vehicles' | 'lockers'
  | 'jobs' | 'teams' | 'manage-my-team' | 'schedule' | 'logs' | 'users' | 'roles' | 'settings' | 'chat' | 'media'   // tiles
  | 'section' | 'quick-add' | 'low-stock' | 'on-call'                        // non-tile blocks
  | 'vehicle-checkin' | 'gas-receipt' | 'past-due' | 'low-stock-catalog' | 'schedule-gaps' // contextual quick-actions (#144, #168, #224)
  | 'stat-tiles' | 'work-list' | 'activity-preview' | 'activity-digest';     // config-driven data widgets (role dashboards, #227)

// --- Per-widget config payloads (role dashboards §2) -------------------------
// One widget type renders different content depending on its block config.
// Every field is optional so ANY persisted config object parses; unknown fields
// from a newer app version are carried through untouched (forward compat) and
// simply ignored by the renderer.

// Count sources a `stat-tiles` block can show (existing local queries only).
export type StatSource =
  | 'my-checkouts'       // my active checkouts (stock + deployed units)
  | 'open-repairs'       // getRepairs({ done: false })
  | 'units-due-service'  // getUnitsDueForService
  | 'low-stock'          // getLowStockItems
  | 'open-jobs'          // getOpenJobs
  | 'team-members'       // getAllActiveUsers
  | 'vehicles-available' // #177: vehicle locations passing isVehicleAvailableForCheckout
  | 'shared-media'       // pool photos shared to me (getSharedPoolMediaCount)
  | 'scheduled-today';   // #225: crew with a slot on today's board, as scheduled/total

// Row sources a `work-list` block can show.
export type WorkListSource =
  | 'my-equipment'       // getDeployedUnitsForUser
  | 'my-jobs'            // getMyAssignedJobs (#160: direct or via my crew)
  | 'my-schedule-today'  // #207: getScheduleAssignmentsForEmployee(uid, today)
  | 'stranded-equipment' // #223: getUnitsStrandedOnClosedJobs — deployed units on closed jobs
  | 'open-jobs'
  | 'open-repairs'
  | 'units-due-service'
  | 'low-stock'
  | 'vehicles';          // #177: vehicle locations with availability

export type WidgetConfig = {
  // Tile/section overrides (pre-existing).
  label?: string;
  icon?: string;
  sectionTitle?: string;
  // stat-tiles: which count cards to show, in order (2–4 recommended).
  stats?: StatSource[];
  // work-list: which rows to list.
  source?: WorkListSource;
  // work-list + activity-preview: card title override and row cap.
  title?: string;
  limit?: number;
};

export type LayoutBlock = {
  widget: WidgetType;
  width: 'full' | 'half';
  config?: WidgetConfig;
};

export type Layout = LayoutBlock[];

export type WidgetDef = {
  label: string;
  icon?: string;
  route?: string;
  // The permission this tile is gated by on today's hub. Absent for `block` kinds.
  requiredPermission?: Permission;
  kind: 'tile' | 'block';
  // Section-bundle metadata (#189/#190/#191): only set on the plain
  // single-permission nav tiles that appear in one of the three section runs
  // (Inventory Management / Operations / Admin) on DEFAULT_LAYOUT and
  // ADMIN_LAYOUT. bundles.ts's buildSection() groups by `section` and orders
  // by `weight` (stable tiebreak = registry declaration order below). NOT set
  // on stat-tiles/work-list/quick-action/section widgets — those are
  // per-placement config, not fixed nav tiles.
  section?: 'inventory' | 'operations' | 'admin';
  weight?: number;
};

// EXACT reproduction of the current dashboard's tiles (label / icon / route /
// PermissionGate permission — see apps/mobile/app/(app)/(dashboard)/index.tsx).
// Keep the permission column in lockstep with that screen's gates.
export const WIDGET_REGISTRY: Record<WidgetType, WidgetDef> = {
  // Primary + checkout actions
  // Fast checkout (#127): "where are you working from?" source picker → scoped hub.
  // No requiredPermission — access is data-driven (accessible lockers/vehicles);
  // the screen renders an EmptyState when the user has none.
  'fast-checkout': { label: 'Fast Checkout',         icon: '⚡', route: '/(app)/(crew)', kind: 'tile' },
  // Fast check-in (#83): same source picker in return mode. No requiredPermission
  // (data-driven access, like fast-checkout); the picker gates on accessible sources.
  'fast-checkin':  { label: 'Fast Check-In',         icon: '↩', route: '/(app)/(crew)?dir=in', kind: 'tile' },
  // Scan launcher (#206): straight to the universal scan screen (resolveScan
  // classifies whatever is scanned). No requiredPermission — like fast-checkout,
  // what a scan can DO is decided per result by that screen's own gates.
  scan:          { label: 'Scan',                    icon: '📷', route: '/(app)/(inventory)/scan', kind: 'tile' },
  checkout:      { label: 'Check Out Item',          icon: '📦', route: '/(app)/(checkout)', requiredPermission: 'checkout_inventory', kind: 'tile' },
  checkin:       { label: 'Check In',                icon: '↩',  route: '/(app)/(checkin)',  requiredPermission: 'checkin_inventory',  kind: 'tile' },
  'my-checkouts':{ label: 'My Active Checkouts',     icon: '📋', route: '/(app)/(jobs)',     requiredPermission: 'checkout_inventory', kind: 'tile' },

  // Inventory Management (section run — order below is the section's weight order).
  'add-stock':   { label: 'Add Stock to Location',   icon: '+',   route: '/(app)/(inventory)/add', requiredPermission: 'add_inventory',  kind: 'tile', section: 'inventory', weight: 10 },
  equipment:     { label: 'Manage Equipment Catalog',icon: '🛠️', route: '/(app)/(equipment)',     requiredPermission: 'add_inventory',  kind: 'tile', section: 'inventory', weight: 20 },
  repairs:       { label: 'Repairs',                 icon: '🔧',  route: '/(app)/(repairs)',       requiredPermission: 'add_inventory',  kind: 'tile', section: 'inventory', weight: 30 },
  locations:     { label: 'Manage Locations',        icon: '⇄',   route: '/(app)/(locations)',     requiredPermission: 'view_locations',  kind: 'tile', section: 'inventory', weight: 40 },
  // Vehicles/lockers as their own system (#122 A2): no requiredPermission —
  // visibility is data-driven (getVisibleUnits); the screens render an EmptyState.
  // Half-width pair — see bundles.ts's HALF_WIDTH set.
  vehicles:      { label: 'Vehicles',                icon: '🚐',  route: '/(app)/(vehicles)',      kind: 'tile', section: 'inventory', weight: 50 },
  lockers:       { label: 'Lockers',                 icon: '🔒',  route: '/(app)/(lockers)',       kind: 'tile', section: 'inventory', weight: 60 },
  'item-catalog':{ label: 'Manage Item Catalog',     icon: '✎',   route: '/(app)/(inventory)',     requiredPermission: 'edit_inventory', kind: 'tile', section: 'inventory', weight: 70 },

  // Operations (section run).
  jobs:          { label: 'Jobs',                    icon: '🏗', route: '/(app)/(jobs)',  requiredPermission: 'create_jobs',   kind: 'tile', section: 'operations', weight: 20 },
  teams:         { label: 'Teams',                   icon: '👥', route: '/(app)/(teams)', requiredPermission: 'view_teams',   kind: 'tile', section: 'operations', weight: 30 },
  // Manage My Team (#124): no requiredPermission — ownership is data (my crews /
  // lockers / vehicles); the screen shows an EmptyState when the user owns nothing.
  'manage-my-team': { label: 'Manage My Team',       icon: '👥', route: '/(app)/(myteam)', kind: 'tile', section: 'operations', weight: 40 },
  // Employee day schedule board (#184): open to every authenticated user —
  // crews need to SEE their day (live review 2026-08-01); the board screen
  // itself gates editing on manage_schedule and renders read-only otherwise.
  schedule:      { label: 'Schedule',                icon: '🗓', route: '/(app)/(schedule)', kind: 'tile', section: 'operations', weight: 50 },
  logs:          { label: 'Activity Logs',           icon: '📊', route: '/(app)/(logs)',  requiredPermission: 'view_all_logs', kind: 'tile', section: 'operations', weight: 70 },
  // Chat is available to every authenticated user — no requiredPermission gate.
  chat:          { label: 'Messages',                icon: '💬', route: '/(app)/(chat)', kind: 'tile', section: 'operations', weight: 10 },
  // Media hub is open to everyone too; the screen itself gates 'Everything'.
  media:         { label: 'Media',                   icon: '🖼️', route: '/(app)/(media)', kind: 'tile', section: 'operations', weight: 60 },

  // Admin (section run).
  users:         { label: 'Users & Permissions',     icon: '👤', route: '/(app)/(admin)/users',    requiredPermission: 'manage_users',              kind: 'tile', section: 'admin', weight: 10 },
  roles:         { label: 'Roles & Permissions',     icon: '🛡', route: '/(app)/(admin)/roles',    requiredPermission: 'manage_roles_permissions', kind: 'tile', section: 'admin', weight: 20 },
  // Settings is open to EVERY role (role dashboards §4): the screen renders for
  // everyone (My Profile / Theme / App Info / Logout are all-roles) and gates its
  // admin sections internally. The dashboard also pins a header gear to this
  // route, so settings stays reachable even for layouts without this tile.
  settings:      { label: 'Settings',                icon: '⚙', route: '/(app)/(admin)/settings', kind: 'tile', section: 'admin', weight: 30 },

  // Non-tile blocks (no required permission; render as they do today).
  // ('search' was removed: DashboardSearch is pinned by the screen itself.)
  section:       { label: '', kind: 'block' },
  'quick-add':   { label: '', kind: 'block' },
  'low-stock':   { label: '', kind: 'block' },
  // On-call block (#128): fully self-contained <OnCallWidget/> (owns its data reads,
  // modal + calendar; self-gates editing on manage_teams internally).
  'on-call':     { label: '', kind: 'block' },

  // Contextual quick-actions (#144): visibility is DATA-driven (computed by
  // src/dashboard/quickActions.ts from the user's open vehicle session, past-due
  // repairs/service and the low-stock list), so like the other blocks they carry
  // no requiredPermission — past-due and low-stock self-gate on edit_inventory
  // inside the compute, mirroring localAlerts' scoping.
  'vehicle-checkin':   { label: '', kind: 'block' },
  'gas-receipt':       { label: '', kind: 'block' }, // #168: shows only with an open vehicle session
  'past-due':          { label: '', kind: 'block' },
  'low-stock-catalog': { label: '', kind: 'block' },
  // #224: unscheduled-crew card; self-gates on manage_schedule in the compute.
  'schedule-gaps':     { label: '', kind: 'block' },

  // Config-driven data widgets (role dashboards §2). stat-tiles and work-list
  // gate PER SOURCE inside the component (each source mirrors the permission of
  // the tile/list it taps through to), so the block itself carries none.
  // activity-preview reuses the Activity Logs gate — same as the logs tile.
  'stat-tiles':       { label: 'Stat Tiles',       icon: '🔢', kind: 'block' },
  'work-list':        { label: 'Work List',        icon: '🗒', kind: 'block' },
  'activity-preview': { label: 'Recent Activity',  icon: '📊', kind: 'block', requiredPermission: 'view_all_logs' },
  // #227: 7-day action-type counts; same gate as the preview it sits beside.
  'activity-digest':  { label: 'This Week',        icon: '📈', kind: 'block', requiredPermission: 'view_all_logs' },
};

// True when a widget key is a real registry entry — used to validate a persisted
// preset's blocks before rendering (drop unknown widget types from another app
// version rather than crash).
export function isWidgetType(w: unknown): w is WidgetType {
  return typeof w === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_REGISTRY, w);
}
