// Item categories (the catalog `category` / item-type label) that are consumed,
// worn, or used up rather than repaired — these never show a "Report repair"
// action. Matched case-insensitively, and via substring so compound labels like
// "Air Filters" or "Cleaning Chemicals" are covered too.
const NON_REPAIRABLE_KEYWORDS = ['ppe', 'filter', 'consumable', 'chemical'];

/** False for consumable-type categories (PPE, filters, consumables, chemicals). */
export function isRepairableCategory(category?: string | null): boolean {
  if (!category) return true;
  const c = category.trim().toLowerCase();
  return !NON_REPAIRABLE_KEYWORDS.some(k => c.includes(k));
}
