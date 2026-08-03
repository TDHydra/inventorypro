// Configurable dashboard foundation (Wave B / D1). A dashboard is a Layout: an
// ordered list of blocks. Each block references a WidgetType in WIDGET_REGISTRY,
// which carries the widget's presentation (label/icon), navigation target (route),
// and — critically — the SAME permission the tile is gated by on today's hub. The
// hub wraps every tile in <PermissionGate permission={registry.requiredPermission}>
// so a preset can NEVER surface a tile the user isn't authorized for.
//
// The registry (data) itself lives in ./widgetRegistry — this file re-exports it
// unchanged (every existing `from './widgets'` import keeps working) and adds the
// one thing that isn't pure data: DEFAULT_LAYOUT, composed from ./bundles.
//
// Layering (no circular imports): widgetRegistry.ts is the base (types + the
// WIDGET_REGISTRY data, no local imports besides the Permission type). bundles.ts
// depends on widgetRegistry.ts only, for its buildSection()/composeLayout() helpers.
// This file (widgets.ts) sits on top of BOTH — it re-exports widgetRegistry.ts and
// imports bundles.ts to compose DEFAULT_LAYOUT. If widgetRegistry.ts's registry
// lived here instead, bundles.ts and widgets.ts would import each other (bundles
// needs the registry; widgets needs bundles' composer) — a cycle. Extracting the
// registry into its own file keeps the dependency graph a DAG:
//   widgetRegistry.ts  <—  bundles.ts  <—  widgets.ts (also re-exports widgetRegistry.ts)
export * from './widgetRegistry';

import { composeLayout, buildSection } from './bundles';
import type { Layout } from './widgetRegistry';

// The built-in default dashboard, expressed as blocks in the EXACT order/width the
// current hub renders. An unassigned user (no per-user or per-role preset) resolves
// to this, so their dashboard is unchanged. Every tile here is still wrapped in its
// PermissionGate by the hub, so roles without a permission never see that tile —
// identical to today. The three section runs (Inventory Management / Operations /
// Admin) are built from the registry's section/weight metadata (#189/#190/#191) so
// they and ADMIN_LAYOUT's identical runs can never drift apart; everything above
// and below them is hand-listed since those tiles aren't part of a section run.
// (No 'search' block: DashboardSearch is pinned above every resolved layout.)
export const DEFAULT_LAYOUT: Layout = composeLayout(
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
  // #206: one-tap scan launcher right under the fast pair.
  { widget: 'scan', width: 'full' },
  { widget: 'checkout', width: 'full' },
  { widget: 'checkin', width: 'full' },
  { widget: 'my-checkouts', width: 'full' },

  buildSection('inventory', 'Inventory Management'),
  buildSection('operations', 'Operations'),
  buildSection('admin', 'Admin'),

  { widget: 'low-stock', width: 'full' },
  { widget: 'on-call', width: 'full' },
);
