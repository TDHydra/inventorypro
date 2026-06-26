# /inv-seed — Populate Dev Environment

Use this skill to seed the database with realistic test data for development and testing.

## Prerequisites

- Docker Compose is running (`pnpm infra:up`)
- Postgres is healthy (`docker compose ps`)
- Migrations have been applied (`pnpm db:migrate`)

## Run the seed script

```bash
cd ~/inventorypro
pnpm --filter api db:seed
```

Or run directly:
```bash
cd ~/inventorypro/apps/api
npx tsx src/db/seed.ts
```

## What gets seeded

### Users (one per role, all with PIN "1234" for dev)
| Name | Role | PIN length |
|---|---|---|
| Alex Admin | full_admin | 8 |
| Fran Franchise | franchise_manager | 8 |
| Hana HR | hr_manager | 6 |
| Olivia Office | office_manager | 6 |
| Hector Construction | head_of_construction | 6 |
| Callie Contents | head_of_contents | 6 |
| Paula Production | production_manager | 6 |
| Carl Carpet Mgr | carpet_cleaning_manager | 6 |
| Chris Crew | construction_crew | 4 |
| Connie Contents | contents_crew | 4 |
| Mike Mitigation | mitigation_technician | 4 |
| Carly Carpet | carpet_cleaning_crew | 4 |
| Temp Temp | temporary_employee | 4 |

Dev PIN for all: the 4-digit PIN is `1234`, extended with leading zeros for longer requirements (e.g., `00001234` for 8-digit).

### Locations
```
Warehouse
  ├── Backroom
  ├── Shelf A
  └── Receiving Bay
Shop
  ├── Front Counter
  └── Parts Room
Garage
  ├── Shelf 1
  ├── Shelf 2
  └── Lift Bay
```

### Inventory items (20 items across all unit types)

**Liquid:**
- Cleaning Solution (gallon)
- Disinfectant Spray (quart)
- Carpet Shampoo (gallon)
- Deodorizer (pint)

**Piece:**
- Nitrile Gloves (box/100)
- N95 Respirator Mask (each)
- Tyvek Suit (each)
- Safety Goggles (each)
- Plastic Sheeting Roll (roll)
- Extension Cord 50ft (each)

**Length:**
- Poly Barrier Tape (ft)
- Weather Stripping (ft)

**Weight:**
- Desiccant Pellets (lb)
- Absorbent Powder (lb)

**Piece (equipment):**
- Air Mover Fan (each)
- Dehumidifier (each)
- HEPA Air Scrubber (each)
- Moisture Meter (each)
- Thermal Camera (each)
- Shop Vac (each)

Stock distributed across locations with realistic quantities.

### Jobs (5 open jobs)
- Job #2024-001 — Water damage restoration
- Job #2024-002 — Mold remediation
- Job #2024-003 — Fire restoration
- Job #2024-004 — Carpet cleaning residential
- Job #2024-005 — Contents pack-out

### Teams (2 teams with members)
- **Mitigation Team A** (manager: Paula Production) — Mike Mitigation + 2 others
- **Carpet Crew 1** (manager: Carl Carpet Mgr) — Carly Carpet

### Active checkouts
Several items checked out to jobs/teams so the dashboard shows realistic data.

## Resetting seed data

```bash
# Wipe and re-seed (dev only — DESTROYS ALL DATA)
cd ~/inventorypro/apps/api
npx tsx src/db/seed.ts --reset
```

This drops all rows (not tables) and re-runs the seed.

## Adding to the seed

File: `apps/api/src/db/seed.ts`

Add new items to the appropriate section. Keep the seed idempotent — use `INSERT ... ON CONFLICT DO NOTHING` so re-running doesn't duplicate data.
