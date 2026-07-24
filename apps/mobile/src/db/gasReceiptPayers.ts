import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';
import { parseGasReceiptPayers } from './gasReceiptPayers.logic';

const GAS_RECEIPT_PAYERS_KEY = 'gas_receipt_payers';

// Version counter + listeners for sync reactivity (same pattern as
// hiddenFields.ts / permissions.ts). notifyGasReceiptPayersChanged is called:
// (a) by the settings screen after a save commit (#168 UI phase), and (b) by
// the sync engine after a pull.
let cacheVersion = 0;
const listeners = new Set<() => void>();

export function subscribeGasReceiptPayers(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getGasReceiptPayersVersion(): number {
  return cacheVersion;
}

/** Bump the version counter so all subscribers re-render. */
export function notifyGasReceiptPayersChanged(): void {
  cacheVersion++;
  listeners.forEach(l => l());
}

/** Current payer list; code default when the key is absent (never seeded). */
export function getGasReceiptPayers(): string[] {
  return parseGasReceiptPayers(getAppConfig(GAS_RECEIPT_PAYERS_KEY));
}

/**
 * Persist the full list and push through the outbox. Call
 * notifyGasReceiptPayersChanged() after the enclosing transaction commits.
 */
export function setGasReceiptPayers(list: string[]): void {
  const value = JSON.stringify(list);
  setAppConfigLocal(GAS_RECEIPT_PAYERS_KEY, value);
  appendOutbox('INSERT', 'app_config', {
    key: GAS_RECEIPT_PAYERS_KEY,
    value,
    updated_at: new Date().toISOString(),
  });
}
