// Test-only preload (node --test via `--import`). React Native / Expo modules
// reference the `__DEV__` global at load time (e.g. expo/src/async-require/
// setup.ts), which is injected by the Metro runtime but absent under plain
// `node --test`. Any test that transitively imports a db/query module (which
// pulls in op-sqlite → expo) crashed on `__DEV__ is not defined` before this.
// Default to production mode (false) — the safe non-dev path.
if (typeof globalThis.__DEV__ === 'undefined') {
  globalThis.__DEV__ = false;
}
