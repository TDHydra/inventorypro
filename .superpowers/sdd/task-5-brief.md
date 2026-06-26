## Task 5: Locations owner picker

**Files:**
- Modify: `apps/mobile/app/(app)/(locations)/index.tsx`

**Interfaces:**
- Consumes: `getAllActiveUsers` (users.ts) for the person list; existing `upsertLocation` (now writes `owner_user_id`); `appendOutbox`.

- [ ] **Step 1: Add an optional "Belongs to (person)" field to the create/edit modal**

In the location create modal state, add `ownerId: string | null` (default null). Render a `SearchablePicker` (options = active users, label=name, sublabel=role) labeled "Belongs to (optional)". Include `owner_user_id: ownerId` in both the `upsertLocation({...})` payload and the `appendOutbox('INSERT','locations', { ... owner_user_id: ownerId })` payload. On owned-location cards, show `Owner: <name>` when set.

- [ ] **Step 2: Compile gate**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 3: On-device + e2e verify**

Create a location "Pete's Van", owner = a user. Confirm it appears with the owner, then:
```bash
sg docker -c "docker exec infra-postgres-1 psql -U inventorypro -d inventorypro -tAc \"SELECT name, owner_user_id IS NOT NULL AS owned FROM locations WHERE name='Pete''s Van'\""
```
Expected: `Pete's Van|t`.

- [ ] **Step 4: Checkpoint** — owner persists locally and syncs.

---

