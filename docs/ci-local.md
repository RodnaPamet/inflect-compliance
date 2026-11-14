# Local CI & E2E Guide

Run the full CI pipeline locally before pushing. Works on Windows, macOS, and Linux.

## Prerequisites

- **Docker** (with Docker Compose v2)
- **Node.js** ≥ 18 (20 recommended)
- **npm** ≥ 9

## Quick Start

```bash
# 1. Copy env files (one-time)
cp .env.test.example .env.test
cp .env.e2e.example .env.e2e

# 2. Run local CI (lint → typecheck → jest → build)
npm run ci:local

# 3. Run local E2E (build → seed → playwright)
npm run e2e:local
```

## Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| `npm run ci:local` | `node scripts/ci-local.mjs` | Full CI: lint, typecheck, migrate, jest, build |
| `npm run e2e:local` | `node scripts/e2e-local.mjs` | Full E2E: build, seed, playwright |
| `npm run db:test:up` | `docker compose -f docker-compose.test.yml up -d` | Start test DB only |
| `npm run db:test:down` | `docker compose -f docker-compose.test.yml down -v` | Stop + wipe test DB |

### Flags

```bash
# CI: skip docker (DB already running)
npm run ci:local -- --skip-db

# CI: skip build step
npm run ci:local -- --no-build

# E2E: skip docker
npm run e2e:local -- --skip-db

# E2E: run headed (visible browser)
npm run e2e:local -- --headed
```

## What Each Pipeline Does

### `ci:local`

```
1. docker compose -f docker-compose.test.yml up -d
2. npm ci
3. npx prisma generate
4. npm run lint
5. npm run typecheck
6. npx prisma migrate reset --force   (fresh schema)
7. npm run test:ci                     (jest --runInBand)
8. npx next build                     (production build)
```

### `e2e:local`

```
1. docker compose -f docker-compose.test.yml up -d
2. npx prisma generate
3. npx prisma migrate reset --force
4. npx tsx prisma/seed.ts              (seed demo data)
5. npx next build                     (production build)
6. npx playwright install chromium
7. npx playwright test                (AUTH_TEST_MODE=1)
```

## Test Database

| Setting | Value |
|---------|-------|
| Image | `postgres:16-alpine` |
| Port | `5434` — the same host port the dev stack's direct Postgres publishes (`docker-compose.yml`), so stop the dev stack's `postgres` first |
| User | `test` |
| Password | `test` |
| Database | `inflect_test` |
| Storage | tmpfs (in-memory, wiped on container stop) |

The DB uses `tmpfs` so data is stored in RAM — fast and always clean on restart.

## Troubleshooting

### Port 5434 already in use

The dev stack (`docker compose up -d`) publishes its direct Postgres on
5434 as well, and is the usual holder of the port.

```bash
# Stop any existing test container
npm run db:test:down

# Or stop the dev stack's direct Postgres
docker compose stop postgres

# Or kill the process on port 5434
# Windows: netstat -ano | findstr :5434
# macOS/Linux: lsof -i :5434
```

### Env validation errors

Ensure `SKIP_ENV_VALIDATION=1` is set (it's in both `.env.test.example` and `.env.e2e.example`).

### Docker not running

Both scripts require Docker. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) or use `--skip-db` if you have Postgres running separately.

### Windows: bash not available

Use the Node scripts directly — they're cross-platform:

```powershell
node scripts/ci-local.mjs
node scripts/e2e-local.mjs
```

### E2E_TEST_MODE security

`AUTH_TEST_MODE=1` is **only** set by `e2e-local.mjs`. It is never set in `.env.test.example` or `ci-local.mjs`. The production app will never have this enabled unless explicitly set.
