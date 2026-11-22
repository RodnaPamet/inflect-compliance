# Staging Deployment Guide

## Prerequisites

- **Docker** + **Docker Compose v2**
- A copy of `.env.staging` (from `.env.staging.example`)

## Quick Start

```bash
# 1. Create env file (first time only)
cp .env.staging.example .env.staging

# 2. Edit .env.staging — set real secrets:
#    AUTH_SECRET, JWT_SECRET, OAuth credentials
#    Generate secrets: openssl rand -base64 32

# 3. Start staging
docker compose -f docker-compose.staging.yml up -d --build

# 4. Verify
docker compose -f docker-compose.staging.yml ps
curl http://localhost:3000
```

## Architecture

```
┌─────────────────────────────────────────┐
│ docker-compose.staging.yml              │
│                                         │
│  ┌─────────┐         ┌──────────────┐  │
│  │ postgres │◄────────│     app      │  │
│  │ :5435    │         │ :3000        │  │
│  │          │         │              │  │
│  │ inflect_ │         │ entrypoint:  │  │
│  │ staging  │         │  1. migrate  │  │
│  └────┬─────┘         │  2. start    │  │
│       │               └──────┬───────┘  │
│  [pgdata]             [uploads:/data]   │
└─────────────────────────────────────────┘
```

## Commands

| Action | Command |
|--------|---------|
| Start | `docker compose -f docker-compose.staging.yml up -d --build` |
| Stop | `docker compose -f docker-compose.staging.yml down` |
| Logs | `docker compose -f docker-compose.staging.yml logs -f app` |
| DB logs | `docker compose -f docker-compose.staging.yml logs -f postgres` |
| Rebuild | `docker compose -f docker-compose.staging.yml up -d --build --force-recreate` |
| Shell | `docker compose -f docker-compose.staging.yml exec app sh` |
| DB shell | `docker compose -f docker-compose.staging.yml exec postgres psql -U inflect inflect_staging` |
| Destroy (data kept) | `docker compose -f docker-compose.staging.yml down` |
| Destroy (data wiped) | `docker compose -f docker-compose.staging.yml down -v` |

## Update Workflow

```bash
# Pull latest code
git pull origin main

# Rebuild and restart (migrations run automatically on boot)
docker compose -f docker-compose.staging.yml up -d --build
```

Prisma migrations are applied automatically by `scripts/entrypoint.sh` on every container start — no manual migration step needed.

## Ports

| Service | Default Port | Override via |
|---------|-------------|-------------|
| App | 3000 | `APP_PORT` in .env.staging |
| Postgres | 5435 | `DB_PORT` in .env.staging |

Dev uses 5433 (PgBouncer) and 5436 (direct Postgres), test DB uses 5434,
staging uses 5435. No two of those Postgres ports collide (#5308).

## Seeding

### CLI (recommended)

```bash
# After staging is running, seed from your local machine:
npm run seed:staging

# Or with custom tenant/admin:
STAGING_TENANT_SLUG=my-org STAGING_ADMIN_EMAIL=me@org.com npm run seed:staging
```

### API endpoint (optional)

```bash
# Requires STAGING_SEED_TOKEN set in .env.staging
curl -X POST http://localhost:3000/api/staging/seed \
  -H "x-seed-token: YOUR_STAGING_SEED_TOKEN"
```

The API endpoint is **triple-gated**:
1. `NODE_ENV` must not be `production`
2. `STAGING_SEED_TOKEN` env var must be set
3. `x-seed-token` header must match

### Demo credentials

The seed (`prisma/seed.ts`) provisions these demo users. Their shared
password is set in the seed script and is intentionally **not published
here** — read it from the seed if you need it for local/staging access.

| Role | Email |
|------|-------|
| Admin | `admin@acme.com` |
| Editor | `editor@acme.com` |
| Viewer | `viewer@acme.com` |
| Auditor | `auditor@acme.com` |

### Seeded data

| Entity | Count | Notes |
|--------|-------|-------|
| Tenant | 1 | `acme-corp` |
| Users | 4 | Admin, Editor, Viewer, Auditor |
| Frameworks | 6 | ISO27001, SOC2, NIS2, ISO9001, ISO28000, ISO39001 |
| Controls | 4+ | ISO 27001 Annex A controls |
| Risks | 4 | Cybersecurity + Operational risks |
| Tasks | 5 | Various priorities and statuses |
| Evidence | 4 | Document, certificate, screenshot placeholders |
| Audit Cycles | 1 | ISO 27001 Annual Audit 2024 |

## Troubleshooting

### App won't start

```bash
docker compose -f docker-compose.staging.yml logs app
```

### DB connection refused

```bash
docker compose -f docker-compose.staging.yml ps
```

### Reset staging data

```bash
docker compose -f docker-compose.staging.yml down -v
docker compose -f docker-compose.staging.yml up -d --build
```

## Observability

### Health endpoints

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /api/health` | DB check, version, uptime, latency | None |
| `GET /api/readyz` | Readiness: DB connected + migrations applied | None |

```bash
curl http://localhost:3000/api/health | jq .
# { "status": "healthy", "checks": { "database": { "status": "ok" } }, ... }
```

### Request ID

Every response includes an `x-request-id` header (UUID). Pass it when reporting issues:

```bash
curl -v http://localhost:3000/api/health 2>&1 | grep x-request-id
# < x-request-id: 550e8400-e29b-41d4-a716-446655440000
```

Upstream load balancers can set `x-request-id` and the app will reuse it.

## Smoke Check

```bash
# Against local staging
npm run smoke:staging

# Against remote staging
node scripts/smoke-staging.mjs https://staging.example.com
```

Checks:
1. `/api/health` → healthy + DB ok
2. `/api/readyz` → ready + migrations > 0
3. `/api/auth/session` → responds
4. `/login` → 200
5. `/api/t/acme-corp/controls` → 401 (auth gate works)

## Backup & Restore

### Database backup

```bash
# Dump staging DB
docker compose -f docker-compose.staging.yml exec postgres \
  pg_dump -U inflect inflect_staging > backup_$(date +%Y%m%d).sql

# Restore
docker compose -f docker-compose.staging.yml exec -i postgres \
  psql -U inflect inflect_staging < backup_20240314.sql
```

### Uploads volume snapshot

```bash
# Find volume mount point
docker volume inspect inflect-staging-uploads

# Copy out
docker compose -f docker-compose.staging.yml exec app \
  tar czf /tmp/uploads.tar.gz -C /data/uploads .
docker compose -f docker-compose.staging.yml cp app:/tmp/uploads.tar.gz ./uploads_backup.tar.gz

# Restore
docker compose -f docker-compose.staging.yml cp ./uploads_backup.tar.gz app:/tmp/uploads.tar.gz
docker compose -f docker-compose.staging.yml exec app \
  tar xzf /tmp/uploads.tar.gz -C /data/uploads
```

## Access Protection

For internal staging exposed to a network, add a **reverse proxy** (nginx/Caddy) in front:

```nginx
# nginx example — basic auth for all routes except /api/auth/*
location / {
    auth_basic "Staging";
    auth_basic_user_file /etc/nginx/.htpasswd;
    proxy_pass http://localhost:3000;
}
location /api/auth/ {
    proxy_pass http://localhost:3000;  # no basic auth (OAuth flow)
}
location /api/health {
    proxy_pass http://localhost:3000;  # no basic auth (probes)
}
```

Generate credentials: `htpasswd -c /etc/nginx/.htpasswd tester`

> **Note:** The app does NOT implement its own staging access gate — reverse proxy is the recommended approach to avoid interfering with OAuth callbacks.

