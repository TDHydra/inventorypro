// Page render tests ONLY. The existing ~140 logic/repo tests run under
// `node --import tsx --test` on *.test.ts and must keep doing so (they swap
// db/schema via a Module._load hook that jest has no equivalent for), so the
// two runners are split by extension:
//   *.test.ts   → node:test   (pnpm test:unit)  — logic, repos, migrations
//   *.test.tsx  → jest + RNTL (pnpm test:pages) — page/component renders
// Never name a jest test *.test.ts here; the node runner would try to execute it
// and fail on the JSX-free assumption, and jest would ignore it.
module.exports = {
  preset: 'jest-expo',
  rootDir: __dirname,
  testMatch: ['<rootDir>/app/**/*.test.tsx', '<rootDir>/src/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/test/jest.setup.ts'],
  // jest-expo's own list plus: the workspace packages (@invenpro/* resolve
  // through a pnpm symlink to packages/*/src, which ships untranspiled TSX),
  // and the native/ESM-only libs.
  //
  // NOTE on pnpm: a dep lives at /node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>,
  // so the path contains TWO '/node_modules/' segments. The '.pnpm' allowance
  // only clears the first one — the regex is unanchored and still matches at the
  // inner segment, re-ignoring the package. Every ESM-only dep therefore needs
  // its own name in this list (that is what 'uuid' is doing here; uuid@14 is
  // ESM-only and src/utils/uuid.ts imports it on every write path).
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|@invenpro|react-native-keyboard-controller|react-native-safe-area-context|@quidone|uuid))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  moduleNameMapper: {
    // ONE React instance. pnpm gives packages/core its own react (19.1.0) next
    // to the app's (19.2.3); a hook called from @invenpro/core then reads a
    // different dispatcher and throws "Cannot read properties of null (reading
    // 'useSyncExternalStore')" the moment a screen calls useTableVersion. Metro
    // resolves from the app root so the app itself only ever has one copy —
    // this mapping just makes jest match that.
    '^react$': '<rootDir>/node_modules/react',
    '^react/(.*)$': '<rootDir>/node_modules/react/$1',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react-dom/(.*)$': '<rootDir>/node_modules/react-dom/$1',
    // Same single-instance rule for the two React CONTEXT singletons that
    // @invenpro/ui also imports. packages/ui/node_modules has dangling links for
    // both, so jest resolves them separately from the app's copies and
    // useSafeAreaInsets() inside a ui component cannot see the SafeAreaProvider
    // that test/renderScreen.tsx mounted ("No safe area value available").
    '^react-native-safe-area-context$': '<rootDir>/node_modules/react-native-safe-area-context',
    '^react-native-keyboard-controller$': '<rootDir>/node_modules/react-native-keyboard-controller',
    '^react-native-keyboard-controller/jest$': '<rootDir>/node_modules/react-native-keyboard-controller/jest',
    // db/schema → a real sql.js database built from the manifest DDL. Matches
    // every specifier shape in the codebase: '../db/schema', '../src/db/schema',
    // '../../db/schema', and the bare './schema' / '../schema' used from inside
    // src/db. Anchored with $ so schema.web.ts is NOT caught.
    '^.*/db/schema$': '<rootDir>/test/pageTestDb.ts',
    '^\\.{1,2}/schema$': '<rootDir>/test/pageTestDb.ts',
    // Native-only modules with no JS fallback under jest.
    '^expo-router$': '<rootDir>/test/mocks/expoRouter.tsx',
    '^@op-engineering/op-sqlite$': '<rootDir>/test/mocks/opSqlite.ts',
    '^react-native-webview$': '<rootDir>/test/mocks/webview.tsx',
    '^@quidone/react-native-wheel-picker$': '<rootDir>/test/mocks/wheelPicker.tsx',
    '^@sentry/react-native$': '<rootDir>/test/mocks/sentry.ts',
    '^@zxing/browser$': '<rootDir>/test/mocks/zxing.ts',
  },
  // sql.js loads its wasm with fs/path; the default jsdom-ish RN environment
  // still provides both through jest's module registry.
  clearMocks: false,
  testTimeout: 20000,
};
