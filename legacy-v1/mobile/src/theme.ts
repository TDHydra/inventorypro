/**
 * COMPAT SHIM — static tokens frozen at the Original theme's values.
 *
 * Files importing from here render Original regardless of the selected theme.
 * New/migrated code must use useTheme()/useThemedStyles (src/hooks) instead;
 * the T3 sweep converts remaining importers, after which this module is
 * deleted. Do not add new imports of this file.
 */
import { original } from './themes/original';

export const colors = original.colors;
export const spacing = original.spacing;
export const radii = original.radii;
export const fontSizes = original.typography.fontSizes;
