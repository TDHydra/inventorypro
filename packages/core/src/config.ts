// Injected app configuration — the seam that keeps @invenpro/core free of
// platform imports (no expo env access, no expo-crypto, no secure-store).
// The app calls configureCore() once at startup, before any sync/db module
// runs; every core module reads through getCoreConfig() at call time (never
// at module top), so import order can't race the configuration.

export interface CoreAuth {
  /** A currently-valid access JWT, or null when signed out. */
  getValidJwt(): Promise<string | null>;
  /** Ask the server to settle a token it just refused (revoked ahead of exp).
   *  Fire-and-forget from sync paths; a dead session raises app logout. */
  revalidateSession(): Promise<unknown>;
  getSavedUserId(): Promise<string | null>;
}

export type TrackKind = 'error' | 'audit';

export interface CoreConfig {
  /** API origin, e.g. https://api.invenpro.app — replaces the old module-top
   *  process.env.EXPO_PUBLIC_API_URL reads. */
  apiBase: string;
  generateUUID(): string;
  auth: CoreAuth;
  /** Throws while the local DB is in a non-writable state (maintenance /
   *  restore in progress). Optional — default never blocks. */
  assertWritable?(): void;
  /** Telemetry sink (old src/telemetry track()). Optional — default no-op. */
  track?(kind: TrackKind, name: string, opts?: { props?: Record<string, unknown> }): void;
}

let config: CoreConfig | null = null;

export function configureCore(next: CoreConfig): void {
  config = next;
}

export function getCoreConfig(): CoreConfig {
  if (!config) throw new Error('@invenpro/core not configured — call configureCore() at app startup');
  return config;
}

/** Convenience wrappers used across the sync modules. */
export function apiBase(): string {
  return getCoreConfig().apiBase;
}

export function track(kind: TrackKind, name: string, opts?: { props?: Record<string, unknown> }): void {
  getCoreConfig().track?.(kind, name, opts);
}

export function assertWritable(): void {
  getCoreConfig().assertWritable?.();
}
