// The app has no icon font bundled (see logs/index.tsx) — locations render an
// emoji. Map the Material-style names the seed used onto emoji so seeded rows
// look consistent with ones created in-app.
export const ICON_ALIASES: Record<string, string> = {
  warehouse: '🏭', store: '🏪', local_shipping: '🚚', shelves: '🗄️',
  door_back: '🚪', counter: '🧾', inventory_2: '📦',
};

export const ICON_OPTIONS = [
  // originals
  '📦', '🏭', '🏪', '🚚', '🗄️', '🚪', '🧾', '🛠️', '🧰', '🏬', '🪜', '❄️', '🔥', '💧', '🦠', '🧽', '🧶', '🗂️',
  // people / teams
  '👥', '👷', '🧑‍🔧',
  // equipment / tools
  '🔧', '🪛', '⚙️', '🌀', '💨', '🔌', '🔋', '🧯', '🌡️', '🪣', '🧴', '🚿',
  // classes / labels / status
  '🏷️', '📋', '✅', '⏳',
  // structures / vehicles / storage
  '🏢', '🏠', '🚛', '🚐', '🗃️', '🧱', '🪟',
];

// Per-category fallback icon: when a taxonomy row carries no icon of its own,
// consumer screens still get a distinct, meaningful glyph for the category
// instead of the generic 📍 pin. Keyed by the taxonomy `category` string used in
// db/queries/taxonomy.ts (item_category, job, team, equipment, product_class,
// location_type, location_subtype, repair_status). Every value here is distinct.
export const CATEGORY_DEFAULT_ICON: Record<string, string> = {
  item_category: '📦',
  product_class: '🏷️',
  job: '🧾',
  team: '👥',
  equipment: '🛠️',
  location_type: '🏭',
  location_subtype: '🚪',
  repair_status: '🔧',
};

export const COLOR_OPTIONS = [
  '#1E3A5F', '#2E7D32', '#C62828', '#1565C0', '#6A1B9A',
  '#EF6C00', '#00695C', '#37474F', '#AD1457', '#4527A0',
];

export function renderIcon(icon: string | null): string {
  if (!icon) return '📍';
  return ICON_ALIASES[icon] ?? icon;
}
