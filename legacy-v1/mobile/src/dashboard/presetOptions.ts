import type { DashboardPreset } from '../db/queries/dashboards';

export interface PresetOption { id: string; label: string; sublabel?: string }

// Options for the per-role dashboard SelectField on the Roles & Permissions
// screen: every ACTIVE preset (getDashboardPresets already name-sorts), plus
// the currently-assigned preset even if deactivated — marked 'inactive' so the
// field never hides a live assignment. The "Default" (null) choice is NOT an
// option row; it's the SelectField placeholder + Clear row.
export function dashboardPresetOptions(
  presets: DashboardPreset[],
  assignedId: string | null,
): PresetOption[] {
  return presets
    .filter(x => x.active === 1 || x.id === assignedId)
    .map(x => x.active === 1
      ? { id: x.id, label: x.name }
      : { id: x.id, label: x.name, sublabel: 'inactive' });
}
