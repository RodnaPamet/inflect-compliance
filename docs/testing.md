# Testing Guide

## Quick Reference

```bash
npm test               # All Jest tests (parallel)
npm run test:ci        # All Jest tests (sequential, for CI)
npm run test:coverage  # Jest + coverage report
npm run test:e2e       # Playwright E2E tests
npm run test:all       # Jest + Playwright
npm run typecheck      # TypeScript type check (tsc --noEmit)
```

## Test Structure

```
tests/
├── unit/              # Pure function + structural tests (no DB)
├── integration/       # DB-backed + usecase-level tests
├── guards/            # Architectural guardrail tests
├── e2e/               # Playwright browser tests
├── helpers/
│   ├── factories.ts   # Test data builders
│   └── db.ts          # DB helpers (migrate, reset, client)
├── mocks/
│   └── env.ts         # Environment mock
└── setup/
    ├── globalSetup.ts # Pre-test DB migration
    └── teardown.ts    # Prisma disconnect
```

## How to Run Tests

### Unit Tests Only

```bash
npx jest tests/unit/
```

### Integration Tests Only

```bash
npx jest tests/integration/
```

These need a live Postgres — `docker-compose up -d`, then `npm run db:push` if
the schema has moved. **An unavailable database is a hard failure, not a skip.**
169 files gate on the `DB_AVAILABLE` probe in `tests/integration/db-helper.ts`,
including every cross-tenant isolation, RLS and encryption suite; letting them
skip reports green over exactly the evidence that matters most. To run the
non-DB suites without Postgres, opt out explicitly:

```bash
ALLOW_DB_SKIP=1 npx jest tests/unit/
```

CI never sets that flag. See
[the fail-closed note](implementation-notes/2026-08-11-integration-suites-fail-closed.md).

### Guard Tests Only

```bash
npx jest tests/guards/
```

### Single Test File

```bash
npx jest tests/unit/risk.usecases.test.ts
```

## Test Database Setup

### Option A: Use existing PostgreSQL (default)

Tests use `DATABASE_URL` from `.env`. The globalSetup runs `prisma migrate deploy`.

### Option B: Dedicated test database

Set `DATABASE_URL_TEST` in `.env` or environment:

```bash
# .env
DATABASE_URL_TEST="postgresql://user:password@localhost:5432/inflect_test"
```

The helper in `tests/helpers/db.ts` resolves in order:
1. `DATABASE_URL_TEST` env var
2. `DATABASE_URL` from `.env`
3. Fallback: `postgresql://user:password@localhost:5432/testdb`

### Reset Database Between Tests

```typescript
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma = prismaTestClient();
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));
```

## Writing Tests

### Unit Test Pattern

Unit tests use factory builders to create plain objects — no DB needed:

```typescript
import { buildRequestContext, buildRisk, createRiskWithScore } from '../helpers/factories';

describe('Risk calculation', () => {
    test('score = likelihood * impact', () => {
        const risk = createRiskWithScore(4, 5);
        expect(risk.riskScore).toBe(20);
    });
});
```

### Integration Test Pattern (usecase-level)

Integration tests call usecases directly with constructed `RequestContext`:

```typescript
import { buildRequestContext } from '../helpers/factories';
import { createRisk } from '@/app-layer/usecases/risk';

describe('Risk creation', () => {
    test('READER cannot create risk', async () => {
        const ctx = buildRequestContext({ role: 'READER' });
        await expect(createRisk(ctx as any, { title: 'Test' })).rejects.toThrow();
    });
});
```

### Guard Test Pattern (architectural scan)

Guard tests scan source code for forbidden patterns:

```typescript
import * as fs from 'fs';
import * as path from 'path';

describe('No prisma in routes', () => {
    test('route.ts files must not import prisma', () => {
        const content = fs.readFileSync('src/app/api/.../route.ts', 'utf8');
        expect(content).not.toContain("from '@/lib/prisma'");
    });
});
```

### Available Factories

| Factory | Returns |
|---|---|
| `buildTenant()` | Plain tenant object |
| `buildUser()` | Plain user object |
| `buildMembership()` | Plain membership object |
| `buildRequestContext({ role })` | RequestContext with permissions |
| `buildControl()` | Plain control object |
| `buildRisk()` | Plain risk object |
| `buildEvidence()` | Plain evidence object |
| `buildTask()` | Plain task object |
| `createTenantWithAdmin()` | `{ tenant, user, membership, ctx }` |
| `createControlWithEvidence()` | `{ control, evidence, tenantId }` |
| `createRiskWithScore(l, i)` | Risk with computed score |
| `seedMinimalTenant(role?)` | Full fixture: tenant, user, control, risk, evidence, ctx |

### Mocking RequestContext

The `buildRequestContext` helper creates a valid `RequestContext` for any role:

```typescript
// ADMIN (default)
const ctx = buildRequestContext();

// Specific role
const reader = buildRequestContext({ role: 'READER' });
const editor = buildRequestContext({ role: 'EDITOR' });
const auditor = buildRequestContext({ role: 'AUDITOR' });

// Specific tenant
const ctx = buildRequestContext({ tenantId: 'my-tenant-id', role: 'ADMIN' });

// Custom permissions override
const ctx = buildRequestContext({
    role: 'ADMIN',
    permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
});
```

## Existing Guardrails

| Guard | File | What it prevents |
|---|---|---|
| No prisma in routes | `no-direct-prisma.test.ts` | Direct `prisma.` calls in route handlers |
| No logAudit in routes | `no-direct-prisma.test.ts` | logAudit() calls in routes (should be in usecases) |
| No requireRole in routes | `no-direct-prisma.test.ts` | requireRole() calls in routes (should be in policies) |
| No useState\<any\> | `no-usestate-any.test.ts` | Untyped React state |
| No unsafe any | `no-unsafe-any.test.ts` | `any` type in critical paths |
| No untyped API response | `no-untyped-api-response.test.ts` | Untyped NextResponse.json calls |
| Contract drift | `contract-drift.test.ts` | API contract changes |
| File security | `file-security-guards.test.ts` | File upload/download security |
| Regression scanner | `regression-scanner.test.ts` | Middleware existence, forbidden patterns, schema integrity |

## Coverage

The floors live in `jest.thresholds.json` — one file, five keys, read by
both `jest.config.js` and the CI gate. **[docs/coverage-policy.md](coverage-policy.md)**
is the reasoning behind the numbers: which layer carries which bar and
why, what `global` measures, and the rule that a floor only ever moves
up. The numbers are deliberately not repeated here — a second copy is a
second thing to get wrong.

Two things about the mechanism are worth knowing before you read a
coverage number:

- **`npm run test:coverage` reports; it does not gate.** Jest reads
  `coverageThreshold` from its global config, and this repo sets it on a
  project block, so the run exits 0 whatever it measures. Enforcement is
  `scripts/check-merged-coverage.ts` in the `Coverage (≥60%)` CI job.
- **That job does not run on pull requests** — only on pushes to `main`,
  the weekly schedule, and `workflow_dispatch`. To check a branch before
  merging, dispatch it: `gh workflow run ci.yml --ref <branch>`.
