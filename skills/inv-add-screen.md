# /inv-add-screen — Scaffold a New Screen

Use this skill when adding a new screen to the InventoryPro app. Provide:
- Screen name (e.g., `reports`, `supplier-list`)
- Which tab/section it lives under (e.g., `(inventory)`, `(admin)`)
- Minimum role tier required (1=crew, 2=field manager, 3=office, 4=admin)
- Whether it needs a detail route (e.g., `[id].tsx`)

## Steps

### 1. Create the screen file

Path: `apps/mobile/app/(app)/(<section>)/<name>.tsx`

```tsx
import { View, ScrollView, Text } from 'react-native';
import { Stack } from 'expo-router';
import { PermissionGate } from '../../../src/components/PermissionGate';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { useLogAction } from '../../../src/hooks/useLogAction';

export default function <ScreenName>Screen() {
  // Log that user viewed this screen (optional, only for sensitive screens)
  // const { log } = useLogAction();

  return (
    <PermissionGate permission="<required_permission>" fallback={null}>
      <Stack.Screen options={{ title: '<Screen Title>' }} />
      <ScrollView>
        <TooltipHint
          screenKey="<screen_name>"
          title="<Hint title>"
          body="<What this screen does, role-appropriate>"
        />
        {/* Screen content here */}
        <View>
          <Text>TODO: implement <ScreenName></Text>
        </View>
      </ScrollView>
    </PermissionGate>
  );
}
```

### 2. Add to hints seed

File: `apps/mobile/src/constants/hints.ts`

Add an entry:
```typescript
'<screen_name>': {
  1: { title: '...', body: '...' },  // crew
  2: { title: '...', body: '...' },  // field manager
  3: { title: '...', body: '...' },  // office
  4: { title: '...', body: '...' },  // admin
},
```

### 3. Add to role-aware menu (if top-level)

File: `apps/mobile/app/(app)/(dashboard)/index.tsx`

Add a menu tile inside the appropriate section (`<PermissionGate permission="...">` wrapper).

### 4. Add navigation link (if accessed from another screen)

Use `router.push('/(app)/(<section>)/<name>')` from expo-router.

### 5. If the screen logs user actions

Import `useLogAction` and call `log({ action: 'viewed_<name>', entity_type: '<entity>', entity_id })` on significant events.

### 6. Verify

- [ ] Screen renders without crashing (run `pnpm dev:mobile`)
- [ ] PermissionGate hides screen for roles below minimum tier
- [ ] TooltipHint auto-shows on first visit, dismisses, re-shows on `?` button
- [ ] Navigation link works from parent screen
- [ ] No TypeScript errors (`tsc --noEmit` in `apps/mobile`)

## Notes

- Never put business logic in screen files — extract to hooks in `src/hooks/`
- All data reads go through `src/db/queries/` functions, not raw SQL in components
- All mutations go through `appendOutbox()` in `src/sync/outbox.ts`, never direct SQLite writes
