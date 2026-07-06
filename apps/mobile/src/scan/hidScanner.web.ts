import { sanitizeScan, MAX_BARCODE_LENGTH } from './sanitize';

export function isHidSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

// Requests a HID device and streams decoded ASCII lines. Most HID scanners in
// "USB HID POS" mode emit keyboard usage codes; we accumulate until Enter.
export async function connectHidScanner(onCode: (code: string) => void): Promise<() => void> {
  const nav = navigator as any;
  const [device] = await nav.hid.requestDevice({ filters: [] });
  if (!device) throw new Error('No scanner selected.');
  await device.open();
  let buf = '';
  const handler = (e: any) => {
    const byte = new Uint8Array(e.data.buffer)[0];
    if (byte === 13 || byte === 10) {
      // Bound/clean before emitting — sanitizeScan drops empty/over-length/junk.
      const code = sanitizeScan(buf);
      const had = buf.length > 0;
      buf = '';
      if (code) onCode(code);
      else if (had) console.warn('[hidScanner] dropped invalid scan');
    } else if (byte >= 32) {
      // Cap buffer growth so a runaway device that never sends Enter can't
      // accumulate unbounded memory; let sanitizeScan reject it at the boundary.
      if (buf.length <= MAX_BARCODE_LENGTH) buf += String.fromCharCode(byte);
    }
  };
  device.addEventListener('inputreport', handler);
  return () => { device.removeEventListener('inputreport', handler); void device.close(); };
}
