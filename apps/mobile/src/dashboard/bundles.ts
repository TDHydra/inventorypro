import { WIDGET_REGISTRY, type Layout, type LayoutBlock, type WidgetType } from './widgetRegistry';

// ONE composition mechanism for role dashboards (#189/#190/#191): DEFAULT_LAYOUT
// (widgets.ts) and ADMIN_LAYOUT (roleLayouts.ts) both render the SAME three
// section runs ('Inventory Management' / 'Operations' / 'Admin'). Rather than
// hand-pasting the identical block list twice, each section is derived here
// from the registry's `section`/`weight` metadata — a nav tile's position is
// declared once, in WIDGET_REGISTRY, and both layouts pick it up.
//
// PURE, DB-free (this module is on resolve.ts's import path via widgets.ts —
// no react-native / op-sqlite / store imports here, ever).

// Widgets that render at half width within a section run. Not modeled on
// WidgetDef (step 1 only adds `section`/`weight` to the registry) — this is
// the one place layout width lives for section tiles, matching today's
// hand-written DEFAULT_LAYOUT/ADMIN_LAYOUT runs exactly.
const HALF_WIDTH: ReadonlySet<WidgetType> = new Set(['vehicles', 'lockers']);

function widthFor(widget: WidgetType): 'full' | 'half' {
  return HALF_WIDTH.has(widget) ? 'half' : 'full';
}

// Build one section run: a `section` header block followed by every registry
// nav tile tagged with this `sectionKey`, ordered by ascending `weight` (ties
// broken by registry declaration order — Array.prototype.sort is stable, and
// the candidate list below is built by walking WIDGET_REGISTRY's own key
// order, so equal-weight entries never need a secondary comparator).
export function buildSection(sectionKey: string, title: string): Layout {
  const tiles = (Object.keys(WIDGET_REGISTRY) as WidgetType[])
    .filter(w => WIDGET_REGISTRY[w].section === sectionKey)
    .sort((a, b) => (WIDGET_REGISTRY[a].weight ?? 0) - (WIDGET_REGISTRY[b].weight ?? 0));

  const blocks: Layout = [{ widget: 'section', width: 'full', config: { sectionTitle: title } }];
  for (const w of tiles) blocks.push({ widget: w, width: widthFor(w) });
  return blocks;
}

// Trivial flattener: accepts a mix of single blocks and already-built Layouts
// (e.g. buildSection's output) and concatenates them into one Layout, in the
// order given. Lets a layout be assembled from literal blocks and composed
// section runs side by side, e.g.:
//   composeLayout({ widget: 'quick-add', width: 'full' }, buildSection('admin', 'Admin'))
export function composeLayout(...parts: (LayoutBlock | Layout)[]): Layout {
  const out: Layout = [];
  for (const part of parts) {
    if (Array.isArray(part)) out.push(...part);
    else out.push(part);
  }
  return out;
}
