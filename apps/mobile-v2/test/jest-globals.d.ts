// Page tests are *.test.tsx and ARE typechecked (tsconfig only excludes the
// node-runner *.test.ts files), so tsc needs jest's globals — describe/test/
// expect/beforeEach, and jest.fn() inside test/renderScreen.tsx.
//
// Done as a reference rather than `"types": ["jest"]` in tsconfig.json, because
// setting `types` replaces the automatic @types/* inclusion wholesale and would
// silently drop react/react-native/node typings for the whole app.
/// <reference types="jest" />
