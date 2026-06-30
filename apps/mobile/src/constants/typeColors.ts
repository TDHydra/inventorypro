// Type/category colors so lists are easy to scan. Hybrid model:
//  - AUTO: every distinct item/equipment category name maps to a stable, distinct
//    color (deterministic hash → palette), zero setup, works for free-text
//    equipment categories too.
//  - OVERRIDE: an admin can pin a specific Item Type's color (stored in its
//    taxonomy meta.color); resolveTypeColor prefers the override.

export const TYPE_COLOR_PALETTE: string[] = [
  '#C62828', '#AD1457', '#6A1B9A', '#4527A0', '#283593',
  '#1565C0', '#00838F', '#00695C', '#2E7D32', '#558B2F',
  '#EF6C00', '#5D4037', '#37474F', '#455A64',
];

// Neutral for empty / uncategorized.
export const TYPE_COLOR_FALLBACK = '#64748B';

// Stable hash → palette index so a given category name always gets the same color.
export function autoTypeColor(name: string | null | undefined): string {
  const s = (name ?? '').trim().toLowerCase();
  if (!s) return TYPE_COLOR_FALLBACK;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return TYPE_COLOR_PALETTE[Math.abs(h) % TYPE_COLOR_PALETTE.length];
}

// Effective color for a category label: explicit admin override wins, else auto.
export function resolveTypeColor(name: string | null | undefined, override?: string | null): string {
  const o = override?.trim();
  if (o) return o;
  return autoTypeColor(name);
}
