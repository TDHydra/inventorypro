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

// NOTE (role dashboards): 'search' is no longer a widget — DashboardSearch is
// pinned by the dashboard screen above the resolved layout. Old presets that
// still contain a `search` block parse fine (isWidgetType drops it, so it's
// skipped rather than rendered twice).
export type WidgetType =
  | 'fast-checkout' | 'fast-checkin' | 'checkout' | 'checkin' | 'my-checkouts'
  | 'add-stock' | 'equipment' | 'repairs' | 'locations' | 'item-catalog' | 'vehicles' | 'lockers'
  | 'jobs' | 'teams' | 'manage-my-team' | 'schedule' | 'logs' | 'users' | 'roles' | 'settings' | 'chat' | 'media'   // tiles
  | 'section' | 'quick-add' | 'low-stock' | 'on-call'                        // non-tile blocks
  | 'vehicle-checkin' | 'gas-receipt' | 'past-due' | 'low-stock-catalog'     // contextual quick-actions (#144, #168)
  | 'stat-tiles' | 'work-list' | 'activity-preview';                         // config-driven data widgets (role dashboards)

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
  | 'shared-media';      // pool photos shared to me (getSharedPoolMediaCount)

// Row sources a `work-list` block can show.
export type WorkListSource =
  | 'my-equipment'       // getDeployedUnitsForUser
  | 'my-jobs'            // getMyAssignedJobs (#160: direct or via my crew)
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
  checkout:      { label: 'Check Out Item',          icon: '📦', route: '/(app)/(checkout)', requiredPermission: 'checkout_inventory', kind: 'tile' },
  checkin:       { label: 'Check In',                icon: '↩',  route: '/(app)/(checkin)',  requiredPermission: 'checkin_inventory',  kind: 'tile' },
  'my-checkouts':{ label: 'My Active Checkouts',     icon: '📋', route: '/(app)/(jobs)',     requiredPermission: 'checkout_inventory', kind: 'tile' },

  // Inventory Management
  'add-stock':   { label: 'Add Stock to Location',   icon: '+',   route: '/(app)/(inventory)/add', requiredPermission: 'add_inventory',  kind: 'tile' },
  equipment:     { label: 'Manage Equipment Catalog',icon: '🛠️', route: '/(app)/(equipment)',     requiredPermission: 'add_inventory',  kind: 'tile' },
  repairs:       { label: 'Repairs',                 icon: '🔧',  route: '/(app)/(repairs)',       requiredPermission: 'add_inventory',  kind: 'tile' },
  // #198: viewing the locations list is not the same authority as adding
  // catalog stock — split from add_inventory into its own broadly-granted
  // view_locations permission (KEEP IN SYNC with constants/roles.ts). The
  // screen itself still gates location create/edit affordances internally.
  locations:     { label: 'Manage Locations',        icon: '⇄',   route: '/(app)/(locations)',     requiredPermission: 'view_locations', kind: 'tile' },
  // Vehicles/lockers as their own system (#122 A2): no requiredPermission —
  // visibility is data-driven (getVisibleUnits); the screens render an EmptyState.
  vehicles:      { label: 'Vehicles',                icon: '🚐',  route: '/(app)/(vehicles)',      kind: 'tile' },
  lockers:       { label: 'Lockers',                 icon: '🔒',  route: '/(app)/(lockers)',       kind: 'tile' },
  'item-catalog':{ label: 'Manage Item Catalog',     icon: '✎',   route: '/(app)/(inventory)',     requiredPermission: 'edit_inventory', kind: 'tile' },

  // Operations
  jobs:          { label: 'Jobs',                    icon: '🏗', route: '/(app)/(jobs)',  requiredPermission: 'create_jobs',   kind: 'tile' },
  // #198: viewing team rosters is not the same authority as creating jobs —
  // split from create_jobs into its own broadly-granted view_teams permission
  // (KEEP IN SYNC with constants/roles.ts). manage_teams still gates edits.
  teams:         { label: 'Teams',                   icon: '👥', route: '/(app)/(teams)', requiredPermission: 'view_teams',    kind: 'tile' },
  // Manage My Team (#124): no requiredPermission — ownership is data (my crews /
  // lockers / vehicles); the screen shows an EmptyState when the user owns nothing.
  'manage-my-team': { label: 'Manage My Team',       icon: '👥', route: '/(app)/(myteam)', kind: 'tile' },
  // Employee day schedule board (#184): open to every authenticated user —
  // crews need to SEE their day (live review 2026-08-01); the board screen
  // itself gates editing on manage_schedule and renders read-only otherwise.
  schedule:      { label: 'Schedule',                icon: '🗓', route: '/(app)/(schedule)', kind: 'tile' },
  logs:          { label: 'Activity Logs',           icon: '📊', route: '/(app)/(logs)',  requiredPermission: 'view_all_logs', kind: 'tile' },
  // Chat is available to every authenticated user — no requiredPermission gate.
  chat:          { label: 'Messages',                icon: '💬', route: '/(app)/(chat)', kind: 'tile' },
  // Media hub is open to everyone too; the screen itself gates 'Everything'.
  media:         { label: 'Media',                   icon: '🖼️', route: '/(app)/(media)', kind: 'tile' },

  // Admin
  users:         { label: 'Users & Permissions',     icon: '👤', route: '/(app)/(admin)/users',    requiredPermission: 'manage_users',              kind: 'tile' },
  roles:         { label: 'Roles & Permissions',     icon: '🛡', route: '/(app)/(admin)/roles',    requiredPermission: 'manage_roles_permissions', kind: 'tile' },
  // Settings is open to EVERY role (role dashboards §4): the screen renders for
  // everyone (My Profile / Theme / App Info / Logout are all-roles) and gates its
  // admin sections internally. The dashboard also pins a header gear to this
  // route, so settings stays reachable even for layouts without this tile.
  settings:      { label: 'Settings',                icon: '⚙', route: '/(app)/(admin)/settings', kind: 'tile' },

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

  // Config-driven data widgets (role dashboards §2). stat-tiles and work-list
  // gate PER SOURCE inside the component (each source mirrors the permission of
  // the tile/list it taps through to), so the block itself carries none.
  // activity-preview reuses the Activity Logs gate — same as the logs tile.
  'stat-tiles':       { label: 'Stat Tiles',       icon: '🔢', kind: 'block' },
  'work-list':        { label: 'Work List',        icon: '🗒', kind: 'block' },
  'activity-preview': { label: 'Recent Activity',  icon: '📊', kind: 'block', requiredPermission: 'view_all_logs' },
};

// The built-in default dashboard, expressed as blocks in the EXACT order/width the
// current hub renders. An unassigned user (no per-user or per-role preset) resolves
// to this, so their dashboard is unchanged. Every tile here is still wrapped in its
// PermissionGate by the hub, so roles without a permission never see that tile —
// identical to today. Section headers reproduce the three grouped sections.
// (No 'search' block: DashboardSearch is pinned above every resolved layout.)
export const DEFAULT_LAYOUT: Layout = [
  { widget: 'quick-add', width: 'full' },
  // Shared-media pill on every dashboard (role presets carry it too): photos
  // other users shared to me, tapping through to the media hub.
  { widget: 'stat-tiles', width: 'full', config: { stats: ['shared-media'] } },
  // Contextual quick-actions (#144) sit above the tiles: they render nothing at
  // all unless their condition holds, so the default dashboard is unchanged for
  // anyone without an open vehicle session / past-due work / low stock.
  { widget: 'vehicle-checkin', width: 'full' },
  { widget: 'gas-receipt', width: 'full' },
  { widget: 'past-due', width: 'full' },
  { widget: 'low-stock-catalog', width: 'full' },
  // Fast checkout leads the dashboard (#127); fast check-in (#83) pairs with it.
  { widget: 'fast-checkout', width: 'half' },
  { widget: 'fast-checkin', width: 'half' },
  { widget: 'checkout', width: 'full' },
  { widget: 'checkin', width: 'full' },
  { widget: 'my-checkouts', width: 'full' },

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
  { widget: 'schedule', width: 'full' },
  { widget: 'media', width: 'full' },
  { widget: 'logs', width: 'full' },

  { widget: 'section', width: 'full', config: { sectionTitle: 'Admin' } },
  { widget: 'users', width: 'full' },
  { widget: 'roles', width: 'full' },
  { widget: 'settings', width: 'full' },

  { widget: 'low-stock', width: 'full' },
  { widget: 'on-call', width: 'full' },
];

// True when a widget key is a real registry entry — used to validate a persisted
// preset's blocks before rendering (drop unknown widget types from another app
// version rather than crash).
export function isWidgetType(w: unknown): w is WidgetType {
  return typeof w === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_REGISTRY, w);
}
