# /inv-add-role — Add a New Role

Use this skill when you need to add a new job role to the system.
Provide: role name (display), role key (snake_case), tier (1–4), default PIN length (4–8), and which permissions it should have by default.

## Steps

### 1. Add to the UserRole type

File: `apps/mobile/src/auth/permissions.ts`
```typescript
export type UserRole =
  | 'full_admin'
  | 'franchise_manager'
  // ... existing roles ...
  | '<new_role_key>';  // ← add here
```

File: `apps/api/src/types/roles.ts` (same addition for server-side type safety)

### 2. Add to Postgres ENUM

File: `apps/api/src/db/migrations/<next_NNN>_add_<new_role_key>_role.sql`

```sql
-- Add new value to the user_role enum
ALTER TYPE user_role ADD VALUE '<new_role_key>';

-- Add role_settings entry with PIN length default
INSERT INTO role_settings (role, min_pin_length)
VALUES ('<new_role_key>', <pin_length>)
ON CONFLICT (role) DO NOTHING;
```

Note: Postgres ENUM additions cannot be rolled back without dropping the type. Add new values; never remove them.

### 3. Add to ROLE_TIER and PIN_LENGTH

File: `apps/mobile/src/constants/roles.ts`

```typescript
export const ROLE_TIER: Record<UserRole, 1|2|3|4> = {
  // ... existing ...
  '<new_role_key>': <tier>,  // 1=crew, 2=field manager, 3=office, 4=admin
};
```

### 4. Add to ROLE_DEFAULTS (ALL permissions must be listed)

File: `apps/mobile/src/constants/roles.ts`

Copy the closest existing role's entry as a starting point, then adjust:

```typescript
export const ROLE_DEFAULTS: Record<UserRole, Record<Permission, boolean>> = {
  // ... existing ...
  '<new_role_key>': {
    checkout_inventory: true,
    checkin_inventory: true,
    add_inventory: false,
    edit_inventory: false,
    delete_inventory: false,
    transfer_between_locations: false,
    create_jobs: false,
    close_jobs: false,
    manage_locations: false,
    upload_media: true,
    view_all_logs: false,
    view_own_logs: true,
    manage_teams: false,
    checkout_for_team: true,
    manage_users: false,
    set_pins: false,
    manage_roles_permissions: false,
    view_financial_data: false,
    system_settings: false,
    // ... any new permissions added via inv-add-permission
  },
};
```

### 5. Add to Admin role picker UI

File: `apps/mobile/app/(app)/(admin)/users.tsx`

Add to the role selection list:
```typescript
{ key: '<new_role_key>', label: '<Display Name>', tier: <tier> },
```

### 6. Add PIN length to sync (role_settings table)

The Postgres migration in step 2 handles this. On next full sync, the mobile app receives the new `role_settings` row and uses it when creating users with this role.

### 7. Add display name constant

File: `apps/mobile/src/constants/roles.ts`

```typescript
export const ROLE_DISPLAY_NAMES: Record<UserRole, string> = {
  // ... existing ...
  '<new_role_key>': '<Human Readable Name>',
};
```

### 8. Run migration and verify

```bash
pnpm db:migrate
```

Then:
- [ ] TypeScript compiles in both `apps/mobile` and `apps/api`
- [ ] Admin can create a user with the new role
- [ ] New user's PIN pad shows correct dot count for the role's PIN length
- [ ] `hasPermission()` returns correct values for the new role's defaults
- [ ] New role appears in the Admin roles screen permission matrix
- [ ] `ROLE_DISPLAY_NAMES['<new_role_key>']` shows in user list and profile screens

## Current roles for reference

| Key | Display Name | Tier | Default PIN |
|---|---|---|---|
| full_admin | Full Admin | 4 | 8 |
| franchise_manager | Franchise Manager/Owner | 4 | 8 |
| hr_manager | HR Manager | 3 | 6 |
| office_manager | Office Manager | 3 | 6 |
| head_of_construction | Head of Construction | 2 | 6 |
| head_of_contents | Head of Contents | 2 | 6 |
| production_manager | Production Manager | 2 | 6 |
| carpet_cleaning_manager | Carpet Cleaning Manager | 2 | 6 |
| construction_crew | Construction Crew | 1 | 4 |
| contents_crew | Contents Crew | 1 | 4 |
| mitigation_technician | Mitigation Technician | 1 | 4 |
| carpet_cleaning_crew | Carpet Cleaning Crew | 1 | 4 |
| temporary_employee | Temporary Employee | 1 | 4 |
