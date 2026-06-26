// Tooltip copy keyed by screen and role tier (1=crew, 2=manager, 3=office, 4=admin)
export const HINTS: Record<string, Record<number, string>> = {
  dashboard: {
    1: 'Tap "Check Out Item" to grab equipment for a job. Scan the barcode or search by name.',
    2: 'Use "Add Stock to Location" to receive new inventory. Check the low-stock alerts below.',
    3: 'From here you can manage jobs, teams, and pull activity reports.',
    4: 'Full admin access. Use "Users & Permissions" to manage team roles and overrides.',
  },
  checkout: {
    1: 'Search for the item or scan the barcode. Pick the location that has it in stock.',
    2: 'You can check out for yourself, your whole team, or the office. Assign a job name.',
    3: 'Checkout is logged automatically for accountability. Quantities adjust immediately.',
    4: 'Quantities are adjusted in real time, even offline. Syncs when back online.',
  },
  checkin: {
    1: 'Select the items you are returning and tap "Return Items". Choose where they go back.',
    2: 'All returns are logged. If an item is damaged, add a note in the activity log.',
    3: 'Review the log view for discrepancies after check-ins.',
    4: 'Check-ins are immutably logged. Use the admin log to audit any discrepancies.',
  },
  inventory: {
    1: 'Tap any item to see how much is at each location. Tap "Check Out" to take it.',
    2: 'Use the + button to add new items to the catalog. Set a minimum qty alert.',
    3: 'Filter by type (Liquids, Pieces) to find what you need faster.',
    4: 'Low-stock items appear in orange. Set min_qty_alert on each item to trigger alerts.',
  },
  scan: {
    1: 'Point the camera at a barcode — it will auto-detect. For USB scanners, switch to USB mode.',
    2: 'USB HID scanners work in any field. Plug in and tap USB Mode on this screen.',
    3: 'If the barcode is not found, you can add the item to the catalog immediately.',
    4: 'Supported formats: EAN-13, EAN-8, Code 128, Code 39, UPC-A, QR.',
  },
  users: {
    3: 'Tap a user to set permission overrides. Overrides always win over role defaults.',
    4: 'Set overrides only where the role default is wrong. Leave others untouched.',
  },
  jobs: {
    1: '"My Checkouts" shows everything you currently have checked out.',
    2: 'You can create a job inline during checkout by typing a new name.',
    3: 'Closed jobs are archived. Open jobs show active checkouts.',
    4: 'Jobs are created offline and sync automatically. Status can be changed any time.',
  },
};
