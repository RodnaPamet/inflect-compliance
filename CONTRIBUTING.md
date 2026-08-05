# Contributing to Inflect Compliance

This is the **developer onboarding guide** — the bridge between
[`README.md`](README.md) (boot the app) and [`CLAUDE.md`](CLAUDE.md) (the full
architecture spec). The goal is concrete: **land your first PR within a day.**

It is *not* an architecture spec (that's `CLAUDE.md`), a Next.js/React/TypeScript
tutorial (vendor docs), or a style guide (ESLint + Prettier + structural ratchets
enforce style — this doc names them, it doesn't re-litigate them).

---

## Before you start

**What this product is.** Inflect is a multi-tenant Governance, Risk & Compliance
(GRC) SaaS: organizations manage controls, risks, assets, evidence, policies, and
audits across frameworks (ISO 27001, SOC 2, NIS2, …), with cross-framework
mapping. The user-facing surface is a Next.js web app; everything is scoped to a
tenant. When you change a feature, you're affecting what a compliance team sees
and the audit trail they rely on.

**Required knowledge.** Next.js App Router, React 19, TypeScript. You do **not**
need to know the compliance domain up front — learn it as you touch it.

**Required tooling.**

| Tool | Version | Why |
|------|---------|-----|
| Node | **24** (pinned in `.nvmrc`; `engines` requires `>=24 <25`) | runtime + build |
| npm | **10+** | package manager (lockfile is authoritative — use `npm ci`) |
| Docker Compose | any recent | local PostgreSQL + Redis |
| `psql` | optional | ad-hoc DB inspection |

`nvm use` reads `.nvmrc` and gives you the right Node. The app will not start on
Node < 24.

---

## Local dev loop

Bring up the infra, install, seed, run:

```bash
docker-compose up -d        # PostgreSQL + Redis (required — see Gotchas)
nvm use                     # Node 24
npm ci                      # deterministic install from the lockfile
npm run db:reset            # migrate + seed (DESTRUCTIVE — wipes local data)
npm run dev                 # http://localhost:3000
```

**The five commands that are 95% of daily work:**

| Command | When |
|---------|------|
| `npm run dev` | run the app locally |
| `npm run typecheck` | `tsc --noEmit` — run before every commit |
| `npm test` | Jest (single file: `npx jest path/to/file.test.ts`) |
| `npm run lint` | ESLint (`npm run lint -- --fix` for auto-fixable) |
| `npm run db:reset` | re-migrate + re-seed after a schema change |

The other 35+ scripts live in [`package.json`](package.json) — reach for them
on demand, not on day one.

**Demo users** (provisioned by `prisma/seed.ts`, local dev only — the password is
set in the seed script and is intentionally not published):

| Email | Role |
|-------|------|
| admin@acme.com | Owner |
| editor@acme.com | Editor |
| viewer@acme.com | Viewer |

---

## How the codebase is organized

A 50-line tour. The canonical deep dive is `CLAUDE.md` → **Architecture**; read
this to orient, read that to understand.

```
src/app/api/          HTTP boundary ONLY. Route handlers parse input (Zod),
                      call a usecase, return a response. No business logic here.
                      params are typed Promise<…> (Next 15+); wrap with
                      withApiErrorHandling + requirePermission(<key>) on
                      privileged routes.

src/app-layer/        The business core:
  usecases/           orchestration — validate → policy check → repo → emit event
  policies/           authorization (assertCanRead/Write/Admin) — before data access
  repositories/       ALL Prisma queries — EVERY query filters by tenantId
  jobs/               BullMQ background jobs (executor-registry.ts dispatches)
  services/           cross-cutting domain services
  events/             hash-chained audit-trail writers
  schemas/            Zod input schemas (backend)

src/lib/              shared infra — auth, observability, security, billing,
                      rate-limiting, db (RLS middleware), errors

src/components/       React (UI primitives in src/components/ui/* — use them,
                      never hand-roll a table/modal/button)

prisma/schema/        MULTI-FILE schema (base/auth/compliance/vendor/audit/
                      automation/…). See prisma/schema/README.md. After editing:
                      npm run db:generate.

tests/                unit/ integration/ e2e/ guards/ guardrails/ contracts/
                      rendered/  — see "CI signals" + "Common gotchas"
```

Every usecase and repository receives a `RequestContext` (`userId`, `tenantId`,
`role`, permissions) via AsyncLocalStorage — never thread it manually; access via
`getRequestContext()`. See `CLAUDE.md` → **Request Context**.

---

## Your first PR — a working example

**Task: add a `framework` filter to the Controls list API.** This is a real
vertical slice that touches every layer once. Edit the files **in this order**:

1. **Repository** — `src/app-layer/repositories/ControlRepository.ts`
   Add `framework?: string` to the `ControlListFilters` interface, and apply it
   in the `list(db, ctx, params)` where-clause. Note the method shape every repo
   follows: `static async list(db: PrismaTx, ctx: RequestContext, …)` and the
   where-clause **always** includes `tenantId: ctx.tenantId`. Keep it.

2. **Usecase** — `src/app-layer/usecases/control/queries.ts`
   Thread the new filter from the usecase input into the repo call. The usecase
   calls the policy (`assertCanReadControls(ctx)`) before touching data — leave
   that in place.

3. **Input schema** — the controls route parses its query params with a Zod
   schema. Add `framework: z.string().optional()` to it (define it inline in the
   route, or in `src/app-layer/schemas/` if it's shared).

4. **API route** — `src/app/api/t/[tenantSlug]/controls/route.ts`
   Parse the new query param and pass it into the usecase. The route stays thin:
   parse → usecase → respond.

5. **Test** — extend `tests/unit/control-queries-usecase.test.ts`
   Add a case: given controls across two frameworks, filtering by one returns
   only those. Use `buildRequestContext()` from `tests/helpers/make-context.ts`.

6. **(If applicable) ratchet** — if you added a column to the schema or a new
   `findMany`, a structural guard may fire (see "CI signals"). Read the failure;
   it tells you exactly what to update.

### Before you add a new guard

Two rules, both learned the hard way (2026-08-05: 153 guards retired, ~22,500
lines, none of which had ever caught a bug).

**Name it for the invariant, not for your PR.** `b7-asset-risk-tasks-column`
tells a future reader nothing and can only ever fail when someone refactors.
`no-client-side-filtering` and `rls-coverage` still make sense years later and
still fail for a real reason. Guards named `b7-…`, `item-27-…`, `r14-…`,
`epic55-…`, `pr-b-…` are rejected by
`tests/guards/no-epic-named-ratchets.test.ts`.

**If the rule is structural, write an ESLint rule instead.** Banned imports,
required props, forbidden identifiers, naming conventions — an AST rule
survives reformatting, renaming and class reordering. A `readFileSync` +
regex over source text does not, so it fires on every refactor and on no
regressions. If your guard asserts a Tailwind class order, a variable name,
or the interior spacing of an object literal, it is testing the diff, not the
software.

The cost is not hypothetical. 775 of 2,011 test files were guards, 29 of them
regexing `AssetsClient.tsx` alone — so extracting a shared helper meant
repairing dozens of source-string assertions, and copy-paste was the cheaper
option every time. The suite was holding the duplication in place.

**CI signals you should see go green:** `Typecheck`, `Lint`, `Test (shard N/4)`,
`Build`. Open the PR as a draft first if you want CI feedback before review.

You should be able to follow this and have a real PR open in ~2 hours.

---

## CI signals + how to debug them

The five red flags you'll hit most, in priority order:

1. **`Typecheck` red** → run `npx tsc --noEmit` locally. The error names the file
   + line. Fix the type; do **not** reach for `as any` (see "Contracts").

2. **`Lint` red** → `npm run lint`; try `npm run lint -- --fix` for the
   auto-fixable subset. Remaining issues are real — fix them.

3. **A `tests/guards/*.test.ts` or `tests/guardrails/*.test.ts` failure** → this
   is a **structural ratchet**, not a flaky test. **Read the failure message** —
   it tells you whether you removed something (lower the count/baseline in the
   same PR) or added a regression (revert the thing that tripped it). Never
   "make it green" by gaming the number; the message says which way is correct.

4. **`tests/contracts/api-schemas.test.ts` (or `route-contracts`) red** → you
   changed a Zod schema that's part of the published OpenAPI contract. Run
   `npm run openapi:generate`, then `npx jest tests/contracts -u` to refresh the
   snapshots, and review the diff in your PR.

5. **An `E2E` shard failure** → open the Playwright **HTML report artifact** on
   the failed run; the test name points at the spec file. E2E is serial and
   isolation-sensitive — re-read "Common gotchas" before assuming it's flaky.

**Ask for help** when: a guard failure's message doesn't make sense after you've
read it, or an E2E failure reproduces locally and isn't isolation-related. **Push
through** when: typecheck/lint/contract failures (the fix command is above and
deterministic).

---

## The contracts you cannot break

Internalize these before touching the relevant area. They're enforced — but the
failure is cheaper to avoid than to debug.

- **Audit-log immutability (Epic C).** NEVER `UPDATE` or `DELETE` an `AuditLog` /
  `OrgAuditLog` row. The `IMMUTABLE_AUDIT_LOG` DB trigger refuses it and your code
  explodes at runtime. Write entries only via the hash-chained writer
  (`src/lib/audit/audit-writer.ts` / `logEvent`).

- **`tenantId` on every repository query (Epic A.1 RLS + app-layer defence).**
  PostgreSQL Row-Level Security is the backstop, but a query that forgets
  `tenantId` fails *opaquely* ("0 rows returned", not "permission denied") — and a
  fresh repository method missing the filter is a reviewable defect. Always filter
  by `ctx.tenantId`.

- **Field-encryption manifest (Epic B).** NEVER persist plaintext into an
  encrypted column. The Prisma middleware encrypts on write **only** for fields in
  `src/lib/security/encrypted-fields.ts` — it will not save you if a typed-`any`
  payload side-steps the manifest. Add a model's field there, or it ships in
  cleartext.

- **The `as any` ratchet.** `tests/guardrails/no-explicit-any-ratchet.test.ts`
  caps the `src/` count (currently **0**) and is CI-blocking. Do NOT add a cast to
  paper over a typing problem — fix the type. See `CLAUDE.md` →
  **Codebase-hygiene ratchets**.

---

## Read these next

Eight reads for your first two weeks, in order. Everything *not* on this list is
on-demand — read it when you touch that surface.

1. [`CLAUDE.md`](CLAUDE.md) — the **Architecture** + **Request Context** sections
   (skim, ~15 min). The mental model for every change.
2. [`docs/coverage-policy.md`](docs/coverage-policy.md) — the testing contract:
   what coverage floor your layer carries and why.
3. [`docs/dependency-policy.md`](docs/dependency-policy.md) — read before you add
   a single dependency.
4. [`docs/auth.md`](docs/auth.md) — the auth flow + JWT shape (NextAuth v4).
5. [`docs/billing.md`](docs/billing.md) — SaaS vs. self-hosted modes + entitlements.
6. [`docs/observability/01-deployment-topology.md`](docs/observability/01-deployment-topology.md)
   — where signals flow and how the stack is deployed.
7. [`docs/incident-response.md`](docs/incident-response.md) — skim now; you'll need
   it when you're on call.
8. [`CLAUDE.md`](CLAUDE.md) — the **Codebase-hygiene ratchets** + **Failing tests**
   sections. How the ratchets think, and the "a failing test is a failing test"
   rule.

---

## When something goes wrong — escalation paths

- **Stuck on a CI failure** → open a **draft PR** and ask the team in the PR
  thread; paste the failing job's error.
- **Suspected security issue** → [`SECURITY.md`](SECURITY.md) (private GitHub
  Security Advisory — do not open a public issue).
- **Unsure whether to add a dependency** →
  [`docs/dependency-risk-review.md`](docs/dependency-risk-review.md).
- **Production runtime issue** → [`docs/incident-response.md`](docs/incident-response.md).
- **Shipping a migration / infra / secret-rotation change** → it's a SIGNIFICANT
  change: include a rollback plan + a second engineer's `Sign-off:`. See
  [`docs/change-management-policy.md`](docs/change-management-policy.md).
- **A structural ratchet you don't understand** → read its docstring (top of the
  test file) — they're written to explain themselves — then ask in the PR.

---

## Common gotchas

The paper cuts that bite new contributors:

1. **The Prisma schema is FOLDER-based, not one file.** Edit
   `prisma/schema/<domain>.prisma`, then run `npm run db:generate`. The generator
   + datasource live ONLY in `base.prisma` — don't duplicate them.
2. **`npm run dev` needs Postgres + Redis.** Run `docker-compose up -d` first, or
   it crashes on the first DB/Redis call.
3. **`npm run db:reset` is DESTRUCTIVE.** It drops, re-migrates, and re-seeds —
   you lose local data. That's the point; just know it.
4. **`next dev` compiles routes lazily.** POST to a brand-new route and get a
   one-off 500? Retry — the route JIT-compiled on first hit. (This does NOT happen
   in the production build.)
5. **Jest runs in shards.** A single file works with `npx jest <file>`. To run the
   whole suite the way CI does, use `npm run test:ci` (sequential, no coverage).
6. **E2E spec isolation is structural.** Read the docstring in
   `tests/e2e/fixtures.ts` BEFORE writing a mutating spec — mutating specs use the
   `isolatedTenant`/`authedPage` fixtures; read-only specs share the seeded tenant.
   A cross-test `let` cascade is banned and guard-enforced.
7. **Never `console.log` in server code.** Use the observability `logger` —
   a guard fails CI on `console.*` in `src/`.
8. **Use the UI primitives.** `<DataTable>`, `<Modal>`, `<FilterToolbar>`,
   `<Button>`, etc. live in `src/components/ui/*`. Hand-rolling a `<table>` or a
   `fixed inset-0` overlay trips an Epic-5x ratchet.
9. **`SKIP_ENV_VALIDATION=1`** is set in tests so the env loader doesn't crash;
   never add raw `process.env` access in source — add the var to `src/env.ts`
   first.
10. **Two `DATABASE_URL`s.** `DATABASE_URL` → PgBouncer (runtime); 
    `DIRECT_DATABASE_URL` → direct Postgres (migrations). Don't swap them.

---

Welcome aboard. When in doubt, open a draft PR early and let CI + a reviewer guide
you — that's the fastest path to a merged first change.
