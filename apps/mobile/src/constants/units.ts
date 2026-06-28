import { getProductClasses, getProductClassById } from '../db/queries/taxonomy';

export type UnitCategory = 'liquid' | 'piece' | 'length' | 'weight';

// Fixed seed UUIDs for the 4 default product classes (migration 012). Identical
// on api + mobile. Use these stable ids when creating items in code paths that
// have no class picker (e.g. equipment models), NOT the legacy enum strings —
// migration 012 only remaps EXISTING legacy rows, so new rows must use the id.
export const PRODUCT_CLASS_IDS = {
  liquid: '00000000-0000-4000-8000-000000000c01',
  piece:  '00000000-0000-4000-8000-000000000c02',
  length: '00000000-0000-4000-8000-000000000c03',
  weight: '00000000-0000-4000-8000-000000000c04',
} as const;

// Legacy hardcoded maps. Product classes + their curated units are now
// configurable in taxonomy_types (category 'product_class'); these remain as a
// fallback for the pre-012 enum keys and before the runtime cache has loaded.
export const UNIT_OPTIONS: Record<UnitCategory, string[]> = {
  liquid: ['gallon', 'quart', 'pint', 'cup', 'fl oz', 'liter', 'ml'],
  piece:  ['each', 'pair', 'box', 'case', 'pack', 'set', 'roll'],
  length: ['ft', 'in', 'yd', 'm', 'cm'],
  weight: ['lb', 'oz', 'kg', 'g'],
};

// Whether partial quantities (decimals) are allowed
export const ALLOWS_DECIMALS: Record<UnitCategory, boolean> = {
  liquid: true,
  piece:  false,
  length: true,
  weight: true,
};

// Module-level cache of per-class decimals policy, keyed by product_class id.
// Populated by loadClassConfigCache() at app boot (post-migration) and after
// each sync, so formatQuantity() can stay synchronous with an unchanged
// signature instead of hitting the DB on every render.
let classDecimalsCache: Record<string, boolean> = {};

// Refresh classDecimalsCache from the configurable product classes. Safe to
// call before the DB is ready (or before migration 012) — failures leave the
// existing cache in place so callers fall back to the legacy maps.
export function loadClassConfigCache(): void {
  try {
    const next: Record<string, boolean> = {};
    // includeInactive: items can still reference an archived class; keep its
    // decimals policy so quantities don't silently start rendering decimals.
    for (const cls of getProductClasses({ includeInactive: true })) {
      next[cls.id] = cls.allowDecimals;
    }
    classDecimalsCache = next;
  } catch {
    // DB not initialized / table missing — keep whatever we have.
  }
}

// Curated units for a class id. Resolves the configurable class first, falling
// back to the legacy enum map for pre-012 keys / unknown classes.
export function getUnitsForClass(classId: string): string[] {
  const cls = getProductClassById(classId);
  if (cls) return cls.units;
  return UNIT_OPTIONS[classId as UnitCategory] ?? [];
}

export function formatQuantity(qty: number, unit: string, category: UnitCategory): string {
  const allowDecimals =
    classDecimalsCache[category] ?? ALLOWS_DECIMALS[category as UnitCategory] ?? true;
  const value = allowDecimals
    ? qty % 1 === 0 ? qty.toString() : qty.toFixed(2)
    : Math.round(qty).toString();
  return `${value} ${unit}`;
}
