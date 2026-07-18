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

export type WidgetType =
  | 'fast-checkout' | 'checkout' | 'checkin' | 'my-checkouts'
  | 'add-stock' | 'equipment' | 'repairs' | 'locations' | 'item-catalog'
  | 'jobs' | 'teams' | 'manage-my-team' | 'logs' | 'users' | 'roles' | 'settings' | 'chat' | 'media'   // tiles
  | 'section' | 'search' | 'quick-add' | 'low-stock' | 'on-call';            // non-tile blocks

export type LayoutBlock = {
  widget: WidgetType;
  width: 'full' | 'half';
  config?: { label?: string; icon?: string; sectionTitle?: string };
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
  checkout:      { label: 'Check Out Item',          icon: '📦', route: '/(app)/(checkout)', requiredPermission: 'checkout_inventory', kind: 'tile' },
  checkin:       { label: 'Check In',                icon: '↩',  route: '/(app)/(checkin)',  requiredPermission: 'checkin_inventory',  kind: 'tile' },
  'my-checkouts':{ label: 'My Active Checkouts',     icon: '📋', route: '/(app)/(jobs)',     requiredPermission: 'checkout_inventory', kind: 'tile' },

  // Inventory Management
  'add-stock':   { label: 'Add Stock to Location',   icon: '+',   route: '/(app)/(inventory)/add', requiredPermission: 'add_inventory',  kind: 'tile' },
  equipment:     { label: 'Manage Equipment Catalog',icon: '🛠️', route: '/(app)/(equipment)',     requiredPermission: 'add_inventory',  kind: 'tile' },
  repairs:       { label: 'Repairs',                 icon: '🔧',  route: '/(app)/(repairs)',       requiredPermission: 'add_inventory',  kind: 'tile' },
  locations:     { label: 'Manage Locations',        icon: '⇄',   route: '/(app)/(locations)',     requiredPermission: 'add_inventory',  kind: 'tile' },
  'item-catalog':{ label: 'Manage Item Catalog',     icon: '✎',   route: '/(app)/(inventory)',     requiredPermission: 'edit_inventory', kind: 'tile' },

  // Operations
  jobs:          { label: 'Jobs',                    icon: '🏗', route: '/(app)/(jobs)',  requiredPermission: 'create_jobs',   kind: 'tile' },
  teams:         { label: 'Teams',                   icon: '👥', route: '/(app)/(teams)', requiredPermission: 'create_jobs',   kind: 'tile' },
  // Manage My Team (#124): no requiredPermission — ownership is data (my crews /
  // lockers / vehicles); the screen shows an EmptyState when the user owns nothing.
  'manage-my-team': { label: 'Manage My Team',       icon: '👥', route: '/(app)/(myteam)', kind: 'tile' },
  logs:          { label: 'Activity Logs',           icon: '📊', route: '/(app)/(logs)',  requiredPermission: 'view_all_logs', kind: 'tile' },
  // Chat is available to every authenticated user — no requiredPermission gate.
  chat:          { label: 'Messages',                icon: '💬', route: '/(app)/(chat)', kind: 'tile' },
  // Media hub is open to everyone too; the screen itself gates 'Everything'.
  media:         { label: 'Media',                   icon: '🖼️', route: '/(app)/(media)', kind: 'tile' },

  // Admin
  users:         { label: 'Users & Permissions',     icon: '👤', route: '/(app)/(admin)/users',    requiredPermission: 'manage_users',              kind: 'tile' },
  roles:         { label: 'Roles & Permissions',     icon: '🛡', route: '/(app)/(admin)/roles',    requiredPermission: 'manage_roles_permissions', kind: 'tile' },
  settings:      { label: 'Settings',                icon: '⚙', route: '/(app)/(admin)/settings', requiredPermission: 'manage_roles_permissions', kind: 'tile' },

  // Non-tile blocks (no required permission; render as they do today)
  section:       { label: '', kind: 'block' },
  search:        { label: '', kind: 'block' },
  'quick-add':   { label: '', kind: 'block' },
  'low-stock':   { label: '', kind: 'block' },
  // On-call block (#128): fully self-contained <OnCallWidget/> (owns its data reads,
  // modal + calendar; self-gates editing on manage_teams internally).
  'on-call':     { label: '', kind: 'block' },
};

// The built-in default dashboard, expressed as blocks in the EXACT order/width the
// current hub renders. An unassigned user (no per-user or per-role preset) resolves
// to this, so their dashboard is unchanged. Every tile here is still wrapped in its
// PermissionGate by the hub, so roles without a permission never see that tile —
// identical to today. Section headers reproduce the three grouped sections.
export const DEFAULT_LAYOUT: Layout = [
  { widget: 'search', width: 'full' },
  { widget: 'quick-add', width: 'full' },
  // Fast checkout leads the dashboard (#127): the field tech's first option on login.
  { widget: 'fast-checkout', width: 'full' },
  { widget: 'checkout', width: 'full' },
  { widget: 'checkin', width: 'full' },
  { widget: 'my-checkouts', width: 'full' },

  { widget: 'section', width: 'full', config: { sectionTitle: 'Inventory Management' } },
  { widget: 'add-stock', width: 'full' },
  { widget: 'equipment', width: 'full' },
  { widget: 'repairs', width: 'full' },
  { widget: 'locations', width: 'full' },
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

// True when a widget key is a real registry entry — used to validate a persisted
// preset's blocks before rendering (drop unknown widget types from another app
// version rather than crash).
export function isWidgetType(w: unknown): w is WidgetType {
  return typeof w === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_REGISTRY, w);
}
