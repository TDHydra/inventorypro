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
// version) are dropped rather than crashing the render.
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

// Precedence resolver: per-user assignment wins over per-role assignment; a
// resolved-but-missing/invalid preset falls back to DEFAULT_LAYOUT. Deterministic
// (no DB / module-cache access).
export function resolveLayout(
  userPresetId: string | null | undefined,
  rolePresetId: string | null | undefined,
  byId: Record<string, LayoutPreset>,
): Layout {
  const id = userPresetId ?? rolePresetId ?? null;
  if (!id) return DEFAULT_LAYOUT;
  const preset = byId[id];
  if (!preset) return DEFAULT_LAYOUT;
  return parsePresetLayout(preset.layout) ?? DEFAULT_LAYOUT;
}
