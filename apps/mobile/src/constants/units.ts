export type UnitCategory = 'liquid' | 'piece' | 'length' | 'weight';

export const UNIT_OPTIONS: Record<UnitCategory, string[]> = {
  liquid: ['gallon', 'quart', 'pint', 'cup', 'fl oz', 'liter', 'ml'],
  piece:  ['each', 'pair', 'box', 'case', 'pack', 'set', 'roll'],
  length: ['ft', 'in', 'yd', 'm', 'cm'],
  weight: ['lb', 'oz', 'kg', 'g'],
};

export const UNIT_CATEGORY_LABELS: Record<UnitCategory, string> = {
  liquid: 'Liquid',
  piece:  'Pieces / PPE',
  length: 'Length',
  weight: 'Weight',
};

// Whether partial quantities (decimals) are allowed
export const ALLOWS_DECIMALS: Record<UnitCategory, boolean> = {
  liquid: true,
  piece:  false,
  length: true,
  weight: true,
};

export function formatQuantity(qty: number, unit: string, category: UnitCategory): string {
  const value = ALLOWS_DECIMALS[category]
    ? qty % 1 === 0 ? qty.toString() : qty.toFixed(2)
    : Math.round(qty).toString();
  return `${value} ${unit}`;
}
