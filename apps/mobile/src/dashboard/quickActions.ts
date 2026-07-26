// #144: contextual dashboard quick-actions. Pure logic (no React/DB imports)
// so it unit-tests in plain Node — the dashboard screen feeds it data it read
// reactively, and localAlerts shares isOverdueRepair so the notification and
// the widget can never disagree about what "past due" means.

/** The shared past-due predicate for repairs (also used by localAlerts). */
export function isOverdueRepair(
  r: { due_at?: string | null; status: string },
  isTerminal: (status: string) => boolean,
  nowMs: number,
): boolean {
  return r.due_at != null && !isTerminal(r.status) && new Date(r.due_at).getTime() < nowMs;
}

export type QuickAction =
  | { key: 'vehicle-checkin'; mode: 'check_in'; vehicleLocationId: string; label: string }
  // #149: no active session → the card flips to a check-OUT call-to-action.
  | { key: 'vehicle-checkin'; mode: 'check_out'; label: string }
  // #168: open session → one-tap gas receipt against that vehicle.
  | { key: 'gas-receipt'; vehicleLocationId: string; label: string }
  | { key: 'past-due'; count: number; target: 'repairs' | 'equipment'; label: string }
  | { key: 'low-stock-catalog'; count: number; label: string };

export interface QuickActionsInput {
  /** The current user's open vehicle session, if any. */
  activeVehicleCheckout: { vehicle_location_id: string; vehicle_name?: string | null } | null;
  overdueRepairCount: number;
  serviceDueCount: number;
  /** Past-due and low-stock are scoped to edit_inventory, same as localAlerts. */
  canEditInventory: boolean;
  lowStockCount: number;
}

export function computeQuickActions(input: QuickActionsInput): QuickAction[] {
  const out: QuickAction[] = [];

  if (input.activeVehicleCheckout) {
    const name = input.activeVehicleCheckout.vehicle_name;
    out.push({
      key: 'vehicle-checkin',
      mode: 'check_in',
      vehicleLocationId: input.activeVehicleCheckout.vehicle_location_id,
      label: `Check In ${name ?? 'Vehicle'}`,
    });
    // #168: while a vehicle is out, filing the fuel receipt is one tap away.
    out.push({
      key: 'gas-receipt',
      vehicleLocationId: input.activeVehicleCheckout.vehicle_location_id,
      label: name ? `Gas Receipt · ${name}` : 'Gas Receipt',
    });
  } else {
    out.push({ key: 'vehicle-checkin', mode: 'check_out', label: 'Check Out a Vehicle' });
  }

  if (input.canEditInventory) {
    const pastDue = input.overdueRepairCount + input.serviceDueCount;
    if (pastDue > 0) {
      out.push({
        key: 'past-due',
        count: pastDue,
        target: input.overdueRepairCount > 0 ? 'repairs' : 'equipment',
        label: `${pastDue} past due`,
      });
    }
    if (input.lowStockCount > 0) {
      out.push({
        key: 'low-stock-catalog',
        count: input.lowStockCount,
        label: `${input.lowStockCount} low stock item${input.lowStockCount === 1 ? '' : 's'}`,
      });
    }
  }

  return out;
}
