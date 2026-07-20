import { DEFAULT_LAYOUT, isWidgetType, type Layout, type LayoutBlock } from './widgets';

// PURE, DB-free layout resolution — imported by the reactive store AND by
// store.test.ts (which must not transitively pull in op-sqlite). Keep this module
// free of any DB / native import.

// Minimal shape resolveLayout needs from a preset (structurally satisfied by the
// richer DashboardPreset row from db/queries/dashboards).
export type LayoutPreset = { layout: string | null };

// Validate + parse a preset's persisted `layout` JSON into a Layout. Returns null
// on any problem (missing/empty/invalid JSON, not an array, no valid blocks) so the
// caller falls back to DEFAULT_LAYOUT. Unknown widget types (from another app
// version — including old presets' now-removed 'search' blocks, since search is
// pinned by the screen) are dropped rather than crashing the render. Config
// payloads are carried through as-is: unknown config fields are tolerated and
// simply ignored by the widget renderers (forward compat).
export function parsePresetLayout(raw: string | null | undefined): Layout | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const blocks: LayoutBlock[] = [];
  for (const b of parsed) {
    if (!b || typeof b !== 'object') continue;
    const rec = b as Record<string, unknown>;
    if (!isWidgetType(rec.widget)) continue;
    const width = rec.width === 'half' ? 'half' : 'full';
    const block: LayoutBlock = { widget: rec.widget, width };
    if (rec.config && typeof rec.config === 'object') {
      block.config = rec.config as LayoutBlock['config'];
    }
    blocks.push(block);
  }
  return blocks.length > 0 ? blocks : null;
}

// Precedence resolver (role dashboards §1): user preset → role preset →
// `roleDefault` (the caller passes ROLE_DEFAULT_LAYOUTS[user.role]) →
// DEFAULT_LAYOUT. Each level is tried in turn: a missing/invalid/empty user
// preset falls through to the role preset (DB), and only then to the role
// code-default — an admin-curated role preset is never skipped just because a
// user's personal preset was deleted or corrupted. Deterministic (no DB /
// module-cache access).
export function resolveLayout(
  userPresetId: string | null | undefined,
  rolePresetId: string | null | undefined,
  byId: Record<string, LayoutPreset>,
  roleDefault?: Layout | null,
): Layout {
  for (const id of [userPresetId, rolePresetId]) {
    if (!id) continue;
    const preset = byId[id];
    const parsed = preset ? parsePresetLayout(preset.layout) : null;
    if (parsed) return parsed;
  }
  return roleDefault ?? DEFAULT_LAYOUT;
}
