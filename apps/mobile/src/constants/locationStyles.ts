// The app has no icon font bundled (see logs/index.tsx) — locations render an
// emoji. Map the Material-style names the seed used onto emoji so seeded rows
// look consistent with ones created in-app.
export const ICON_ALIASES: Record<string, string> = {
  warehouse: '🏭', store: '🏪', local_shipping: '🚚', shelves: '🗄️',
  door_back: '🚪', counter: '🧾', inventory_2: '📦',
};

export const ICON_OPTIONS = ['📦', '🏭', '🏪', '🚚', '🗄️', '🚪', '🧾', '🛠️', '🧰', '🏬', '🪜', '❄️', '🔥', '💧', '🦠', '🧽', '🧶', '🗂️'];

export const COLOR_OPTIONS = [
  '#1E3A5F', '#2E7D32', '#C62828', '#1565C0', '#6A1B9A',
  '#EF6C00', '#00695C', '#37474F', '#AD1457', '#4527A0',
];

export function renderIcon(icon: string | null): string {
  if (!icon) return '📍';
  return ICON_ALIASES[icon] ?? icon;
}
