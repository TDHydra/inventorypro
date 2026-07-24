// #168: payer list parsing for gas receipts. Pure module — no db imports — so
// node tests can exercise it (op-sqlite can't load under node).

export const DEFAULT_GAS_RECEIPT_PAYERS = ['Teams', 'Office', 'Contents', 'Construction'];

/**
 * Parse the app_config gas_receipt_payers value. The default lives HERE, in
 * code, applied when the key is absent/invalid/empty — deliberately NOT seeded
 * by a migration (seeded rows miss enrolled devices via incremental pull).
 */
export function parseGasReceiptPayers(raw: string | null): string[] {
  try {
    if (!raw) return DEFAULT_GAS_RECEIPT_PAYERS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_GAS_RECEIPT_PAYERS;
    const valid = parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return valid.length > 0 ? valid : DEFAULT_GAS_RECEIPT_PAYERS;
  } catch {
    return DEFAULT_GAS_RECEIPT_PAYERS;
  }
}
