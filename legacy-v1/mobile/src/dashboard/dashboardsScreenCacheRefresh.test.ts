import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// dashboards.tsx cannot be imported here: it's an Expo Router screen pulling
// in react-native/expo-router, which won't load under `node --test` (same
// reason pull.ts gets a source-text test in pullColumns.test.ts). So assert
// against its source text instead.
//
// #192: every mutator that writes a dashboard preset (setDashboardPresetLayout
// / setDashboardPresetActive) must be followed, in the SAME function, by a
// loadDashboardCache() call — that's what refreshes store.ts's module-level
// presetsById cache and notifies useDashboardLayout's subscribers so the
// editing admin (and everyone else resolved onto that preset) sees the new
// layout immediately instead of waiting for the next sync pull/restart.
// assignRole (the #192 model to mirror) already does this; persist() and its
// siblings (handleDuplicate, handleStartFromRole, handleToggleArchive) did
// not — this test pins that every preset-write function does.
const SRC = readFileSync(
  join(dirname(new URL(import.meta.url).pathname), '../../app/(app)/(admin)/dashboards.tsx'),
  'utf8',
);

const PRESET_WRITE_CALLS = ['setDashboardPresetLayout(', 'setDashboardPresetActive('];

// Extract every top-level `function name(...) { ... }` block by brace-depth
// counting from the opening `{` of the signature to its matching `}` (mirrors
// pullColumns.test.ts's rowToValuesArity brace counting).
function functionBodies(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const sigRe = /^  function (\w+)\([^)]*\)[^{]*\{/gm;
  for (const m of SRC.matchAll(sigRe)) {
    const name = m[1];
    let i = m.index! + m[0].length;
    let depth = 1;
    const start = i;
    for (; i < SRC.length && depth > 0; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') depth--;
    }
    out.push({ name, body: SRC.slice(start, i - 1) });
  }
  return out;
}

test('dashboards.tsx source parses at least the known preset-mutator functions', () => {
  const names = functionBodies().map(f => f.name);
  for (const fn of ['persist', 'handleDuplicate', 'handleStartFromRole', 'handleToggleArchive', 'assignRole']) {
    assert.ok(names.includes(fn), `function extraction missed ${fn} — regex drifted`);
  }
});

test('#192: every function that writes a preset also refreshes the dashboard cache', () => {
  const fns = functionBodies();
  let checked = 0;
  for (const { name, body } of fns) {
    const writesPreset = PRESET_WRITE_CALLS.some(call => body.includes(call));
    if (!writesPreset) continue;
    checked++;
    assert.ok(
      body.includes('loadDashboardCache()'),
      `${name}() writes a dashboard preset but never calls loadDashboardCache() — ` +
      `everyone resolved onto that preset (including the editor) would keep rendering ` +
      `the stale layout until the next sync pull/restart (#192)`,
    );
  }
  assert.ok(checked >= 4, `expected at least 4 preset-writing functions, found ${checked} — regex drifted`);
});
