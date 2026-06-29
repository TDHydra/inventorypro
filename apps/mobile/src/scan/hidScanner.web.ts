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
    if (byte === 13 || byte === 10) { if (buf) { onCode(buf); buf = ''; } }
    else if (byte >= 32) buf += String.fromCharCode(byte);
  };
  device.addEventListener('inputreport', handler);
  return () => { device.removeEventListener('inputreport', handler); void device.close(); };
}
