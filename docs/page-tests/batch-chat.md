# Page tests: batch CHAT & QUICK ADD

| Page | Test file | Tests |
|---|---|---|
| `app/(app)/chat/index.tsx` | `chat/index.test.tsx` | 10 |
| `app/(app)/chat/[id].tsx` | `chat/[id].test.tsx` | 17 |
| `app/(app)/quickadd/index.tsx` | `quickadd/index.test.tsx` | 15 (11 are one `test.each` over the tiles) |
| `app/(app)/quickadd/[sheet].tsx` | `quickadd/[sheet].test.tsx` | 17 (11 are one `test.each` over every supported sheet) |

Total 59, all passing: `cd apps/mobile-v2 && npx jest "app/.app./chat" "app/.app./quickadd"`.

## Shortcuts taken
- `[sheet]` tests prove each of the 11 sheets renders (header title + no redirect) but
  only 4 (location, vehicle, team, job) assert on form fields; the rest are render-only.
  No quick-add form is submitted here.
- Chat image attach (`attachImage`, expo-image-picker/upload) is not tested.
- Add-member / remove-member in the group Details sheet: only the Remove buttons' presence is asserted.
- `chat/index` unread: asserts the per-row badge from `listConversations()`. That screen never
  touches `src/chat/unread.ts`; the cache is covered once in `chat/[id]` (open thread -> cache 0).
- The header "+ New" / "Details" buttons live in `Stack.Screen options.headerRight`, which the
  router mock records but does not render. `[id]` presses Details via the declared element
  (`pressHeaderDetails`); the list screen is driven via its FAB instead.

## Harness gaps found
- `syncNow()` is not mocked: screens that call it (chat send/leave/create) run the real engine,
  which logs `[Sync] Cycle error: Pull failed: undefined` console.warn noise and leaves Jest
  reporting "did not exit one second after the test run". Harmless to results; a global
  `jest.mock` of `syncNow` in `test/jest.setup.ts` would silence it.
- jest path patterns are regexes, so the doc's `npx jest "app/(app)/chat"` matches 0 files
  (parens are a regex group). Use `"app/.app./chat"` (or `app/\(app\)/chat`).
- No helper to press `headerRight` content from `stackScreenOptions`; each test redefines it.
