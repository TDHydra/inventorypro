// src/sync/netinfo.web.ts — minimal NetInfo-compatible surface used by engine.ts
type State = { isConnected: boolean | null };

function addEventListener(cb: (s: State) => void): () => void {
  const on = () => cb({ isConnected: navigator.onLine });
  window.addEventListener('online', on);
  window.addEventListener('offline', on);
  on();
  return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on); };
}

async function fetch(): Promise<State> { return { isConnected: navigator.onLine }; }

// engine.ts consumes this as a default import (NetInfo.addEventListener), so the
// web shim exposes the same default-object surface as the native package.
export default { addEventListener, fetch };
