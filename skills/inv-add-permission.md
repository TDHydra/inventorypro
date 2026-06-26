# /inv-add-permission — Add a New Permission

Use this skill when you need to gate a new action behind a permission flag.
Provide: permission key (snake_case), default per role tier, description.

## Steps

### 1. Add to the Permission type

File: `apps/mobile/src/auth/permissions.ts`

```typescript
// Add to the Permission union type:
export type Permission =
  | 'checkout_inventory'
  | 'checkin_inventory'
  // ... existing ...
  | '<your_new_permission>';  // ← add here
```

### 2. Set role defaults

File: `apps/mobile/src/constants/roles.ts`

Add to EVERY role in `ROLE_DEFAULTS`. Use `false` as the safe default, then set `true` for roles that should have it:

```typescript
export const ROLE_DEFAULTS: Record<UserRole, Record<Permission, boolean>> = {
  full_admin:           { ..., '<your_new_permission>': true },
  franchise_manager:    { ..., '<your_new_permission>': true },
  hr_manager:           { ..., '<your_new_permission>': false },
  office_manager:       { ..., '<your_new_permission>': false },
  head_of_construction: { ..., '<your_new_permission>': false },
  head_of_contents:     { ..., '<your_new_permission>': false },
  production_manager:   { ..., '<your_new_permission>': false },
  carpet_cleaning_manager: { ..., '<your_new_permission>': false },
  construction_crew:    { ..., '<your_new_permission>': false },
  contents_crew:        { ..., '<your_new_permission>': false },
  mitigation_technician: { ..., '<your_new_permission>': false },
  carpet_cleaning_crew: { ..., '<your_new_permission>': false },
  temporary_employee:   { ..., '<your_new_permission>': false },
};
```

### 3. Add to Admin permission toggle UI

File: `apps/mobile/app/(app)/(admin)/roles.tsx`

Add an entry to the permission list rendered for each user/role:
```typescript
{ key: '<your_new_permission>', label: '<Human readable label>', description: '<What granting this allows>' },
```

### 4. Write a Postgres migration for existing users

File: `apps/api/src/db/migrations/<next_number>_add_<your_new_permission>_default.sql`

```sql
-- For users whose role default is TRUE, add override only if not already set
-- Most cases: no migration needed since permission_overrides JSONB defaults to {}
-- and ROLE_DEFAULTS handles the default at runtime.
-- Only needed if you want to explicitly set the override for specific users:

-- Example: grant to all production managers explicitly
UPDATE users
SET permission_overrides = permission_overrides || '{"<your_new_permission>": true}'::jsonb
WHERE role = 'production_manager'
  AND NOT (permission_overrides ? '<your_new_permission>');
```

### 5. Use in code

```tsx
// In a component:
import { usePermission } from '../hooks/usePermission';
const canDoThing = usePermission('<your_new_permission>');

// Or as a gate:
<PermissionGate permission="<your_new_permission>">
  <SensitiveButton />
</PermissionGate>

// Or in API route (server-side):
if (!hasApiPermission(request.user, '<your_new_permission>')) {
  return reply.status(403).send({ error: 'Forbidden' });
}
```

### 6. Verify

- [ ] TypeScript compiles (`tsc --noEmit` in both `apps/mobile` and `apps/api`)
- [ ] A role with `true` default can access the gate
- [ ] A role with `false` default is blocked
- [ ] Admin can toggle the override in the roles screen
- [ ] Override persists through app restart (stored in SQLite `users.permission_overrides`)
- [ ] Sync pushes the override change to server via outbox
