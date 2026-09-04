# 2026-09-04 — the three sender copies #2286's guard could not see

**Commit:** `263a0ba44 fix(notifications): close the three sender copies #2286 left outside its guard`

## Design

PR #2286 fixed a three-month email outage: the tenant fallback sender was a
hardcoded placeholder address, production's relay had verified a different
domain, and every message came back `550 ... domain is not verified` — 520 of
them, with `NotificationOutbox.lastError` having no reader and no alert on the
rate. It gave the address one owner (`src/lib/email/sender-identity.ts`) and
added a test asserting the literal appeared exactly once.

That test's population was `src/**/*.ts(x)`. Three copies lived outside it, and
the interesting one was not a literal in source at all:

```
TenantNotificationSettings.defaultFromEmail  String  @default("<placeholder>")
```

— a column default on the very column `processOutbox` reads to set each
message's `From`. The schema file and the deployed column are two different
facts, and the outage came from the second.

### Why the column default was reachable, not dormant

```
route (no schema)          usecase                        Prisma
─────────────────          ───────                        ──────
body = await req.json()
{ defaultFromEmail:        { ...defaults(),               undefined arg is
    body.defaultFromEmail    ...data }                    DROPPED from the
  }                        └ data's PRESENT-but-          INSERT
  └ key PRESENT,             undefined key overwrites          │
    value undefined          the resolved sender               ▼
                                                          DB default supplies
                                                          the retired address
```

Every step is individually reasonable. The route built all four keys
unconditionally, so an omitted field became a present key with an undefined
value; object spread copies that key; and Prisma treats an undefined argument
as "not supplied" because `strictUndefinedChecks` is a preview feature this repo
does not enable. `tsc` cannot see it either — TypeScript strips `undefined` when
spreading an optional property, so the create payload still satisfies a required
`string`.

### The four levels it is closed at

1. **Route** — parses a zod schema (in `app-layer/schemas/` per convention).
   Absent optional keys are omitted rather than set to undefined, which is the
   property the spread needed. It also validates the addresses, and separates
   "leave `complianceMailbox` alone" from "clear it".
2. **Usecase** — prunes undefined itself, so the seam holds for callers that are
   not that one route.
3. **Schema** — the column default is dropped. `NOT NULL` is retained.
4. **`env.ts`** — a fourth copy existed as a zod default with no consumer;
   the field is now `optional()` and the guard's exclusion for it is deleted.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/schemas/notification-settings.schemas.ts` | New. The PUT body schema — the root fix |
| `src/app/api/t/[tenantSlug]/notification-settings/route.ts` | Parses it instead of trusting `req.json()` |
| `src/app-layer/notifications/settings.ts` | `definedOnly()` prune at the upsert seam |
| `prisma/schema/automation.prisma` | Drops the column default; comments why the sibling keeps its own |
| `prisma/migrations/20260904060000_drop_default_from_email_default/` | `ALTER COLUMN ... DROP DEFAULT` |
| `src/env.ts` | `SMTP_FROM` becomes `optional()` — the default had no consumer |
| `deploy/.env.prod.example`, `docs/auth.md`, `docs/sub-processors.md` | Stop handing operators an undeliverable address |
| `tests/unit/notification-sender-fallback.test.ts` | Guard widened to every tracked file; regression tests for the seam |
| `tests/integration/notification-settings-column-default.test.ts` | New. Proves the migration reached the database |

## Decisions

- **`NOT NULL` retained rather than made nullable.** A nullable column pushes a
  second "what if it is absent" decision into `processOutbox` — the
  two-places-to-decide shape this whole change removes. An insert that omits the
  column now raises 23502 instead of sending from an unverified domain.

- **`defaultFromName` keeps its default, deliberately.** A product name is not a
  deployment fact and no relay can reject it. The asymmetry is written into the
  schema so a later "tidy the other one too" is a decision rather than a reflex;
  the integration test asserts the default is still there.

- **Widening the guard's path prefix would have caught nothing.** The filter was
  `f.startsWith('src/') && /\.tsx?$/` — two predicates, and the second excludes
  `.prisma`, `.md` and `.env.prod.example`, which is every copy #2296 found. The
  population is now every tracked file.

- **Comments are masked for `.ts`/`.tsx` only.** `maskComments` treats `//` as a
  line comment, so over Markdown it deletes everything after the `//` in a URL.
  Applied blanket, it would have hidden the `docs/auth.md` copy the widened scan
  exists to catch — a reach defect of exactly the Class C/D kind this repo
  already documents.

- **Applied migrations are exempt by path.** Their checksums live in
  `_prisma_migrations`; editing one breaks `migrate deploy` everywhere. Two
  migrations necessarily name the address — the one that created the default and
  the one that removes it.

- **A DB test as well as a file scan.** The scan cannot see drift: a `@default`
  removed from the schema but never expressed in a migration leaves every
  existing database still holding it, and production is such a database.

- **`REPLACE_ME_VERIFIED_SENDER_ADDRESS`, not `noreply@example.com`.** The file
  already uses `REPLACE_ME_*` for deployment-specific values, and a
  syntactically valid, plausible-looking address reproduces the defect class:
  copied verbatim, it fails silently on a domain the operator does not own.

- **The tautology was deleted, not repaired.** `notification-settings.test.ts`
  built the defaults object and asserted each field against the literal written
  three lines above, never importing the real `defaults()`. It could not be
  repaired in place — that file mocks the whole settings module — and the real
  behaviour is covered against the real module elsewhere.
