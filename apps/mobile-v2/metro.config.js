const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Page render tests live next to the routes they cover (app/(app)/scan.test.tsx),
// but expo-router builds its route table with require.context over the whole
// app/ directory, and its regex only skips +api / +html / +middleware files — it
// has no notion of a test file. So every *.test.tsx was pulled in as a route AND
// bundled, which drags the jest harness (and better-sqlite3, which needs node's
// fs) into the app bundle:
//
//   Unable to resolve module fs from .../better-sqlite3/lib/database.js
//   Import stack: app (require.context) → approvals/index.test.tsx
//                 → test/pageTestDb.ts → better-sqlite3 → fs
//
// Blocking them keeps them out of metro's file map, so require.context never
// sees them. Appended, not assigned: Expo's default blockList already excludes
// .expo caches, android/ios build dirs and __tests__ directories, and replacing
// it would silently drop those. Jest resolves independently of this file, so
// `pnpm test:pages` is unaffected.
//
// Symptom if this is ever lost: release/dev bundling fails on a NODE BUILTIN
// (fs/path) reached from a test file — not on anything in app code.
config.resolver.blockList = [
  ...config.resolver.blockList,
  /apps[\\/]mobile-v2[\\/]app[\\/].*\.test\.tsx$/,
];

module.exports = config;
