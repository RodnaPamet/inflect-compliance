# 2026-08-01 — usecase-layer list-filter enum casts

**Commit:** `<pending> fix(usecases): validate list-filter enums instead of casting them onto Prisma`

Follow-up to #1763, which closed this bug class in
`src/app-layer/repositories` and named the four surviving usecase sites as
follow-up work. This note closes them and widens the ratchet so the layer
boundary stops being the thing that decides whether the bug is caught.

## Design

### The bug, restated

A list filter is a raw string off the query string. Assigning it to a
Prisma enum column with an `as` cast —

```ts
where.status = filters.status as TestPlanStatus;                 // ✗
...(opts.status ? { status: opts.status as never } : {})         // ✗
```

— tells the compiler the value is already valid. Prisma disagrees at query
time and throws `PrismaClientValidationError` on both shapes the UI
actually produces:

1. **Multi-select.** Every list facet is `multiple: true` and
   `toApiSearchParams` comma-joins, so picking two statuses sends
   `?status=ACTIVE,PAUSED`. Prisma receives one literal string for an enum
   column.
2. **A cross-entity value.** `status` is a shared URL key, so a URL carried
   from Assets or Controls onto another list sends a status that is not in
   that entity's enum.

`PrismaClientValidationError` has no branch in `src/lib/errors/types.ts`,
so it defaults to **500** — and because these pages read the same filters
in their Server Component, the failure takes the render with it
("Something went wrong" on the whole section) rather than failing one
fetch.

### Why the repository fix did not cover these

`#1763` routed every `src/app-layer/repositories` filter through
`parseEnumListFilter` and ratcheted that directory. But four list usecases
assemble their `where` inline rather than delegating to a repository, so
they were never in scope:

| Usecase | Route | Enum |
| --- | --- | --- |
| `listAllTestPlans` | `GET /api/t/:slug/tests/plans?status=` | `TestPlanStatus` |
| `listAgentProposals` | `GET /api/t/:slug/agent-proposals?status=` | `SuggestionItemStatus` |
| `listTenantFrameworkDeltas` | `GET /api/t/:slug/framework-updates?status=` | `FrameworkDeltaStatus` |
| `listWorkflowRuns` | `GET /api/t/:slug/agent-runs?status=` | `WorkflowRunStatus` |

All four routes read the query string with no enum validation — three take
`searchParams.get('status')` verbatim; `/tests/plans` parses with
`z.string().optional()`, which constrains the type but not the value. The
`/tests/plans` one is the live production 500: `TestPlanStatus` has three
members and the `/tests` page's plan facet is multi-select, so
`?status=ACTIVE,PAUSED` is one click away.

### A fifth site, and why layer-scoped ratchets miss it

A full sweep of `usecases` / `services` / `jobs` turned up one more live
instance that neither the old ratchet nor the four-site list would have
caught — `?riskTier=` on the AI-System Registry:

```ts
// src/app/api/t/:slug/ai-systems/route.ts
const riskTier = req.nextUrl.searchParams.get('riskTier') as AiRiskTier | null;  // ✗
```

`AiSystemRepository.list` was *already* fixed by #1763 — but only its
`status` filter. `riskTier` stayed live because the repository declared
`riskTier?: AiRiskTier`, which looked validated, and the route satisfied
that type with an `as` cast on a bare string. The cast had simply moved one
layer up, out of the scanned directory. `?riskTier=HIGH,LIMITED` — a
two-value selection on a four-member enum — 500s.

The chain is now typed honestly: the route passes the raw string, the
usecase and repository both declare `riskTier?: string`, and
`AiSystemRepository.list` validates it with `parseEnumListFilter` exactly
as it already did for `status`. Declaring a filter parameter as the enum
type is what invites the cast; declaring it as `string` makes the missing
parse visible.

The fix is the same everywhere: `parseEnumListFilter(raw,
Object.values(TheEnum), 'label')` — split, trim, dedupe, validate every
member against the real enum, collapse to a scalar or `{ in: [...] }`, and
`badRequest` (400) on anything unknown. The caller owns *which* enum; the
shared helper owns the split and the validation.

### The ratchet

`tests/guards/list-filter-enum-cast.test.ts` now scans three directories
instead of one — `repositories`, `usecases`, `services` — with a recursive
walk (`usecases/` and `services/` have subdirectories; `repositories/` is
flat, which is why the original `readdirSync` sufficed). The regex and the
comment-stripping are unchanged.

An `EXEMPT_CASTS` map is wired in with the conventions this repo uses for
baseline maps: a written reason per entry, a "no stale entries" test that
fails once an exemption stops matching a real line, and a minimum-length
check so a reason cannot be an empty string. It is **empty today** — the
sweep found nothing in those three directories that had to survive — but
the machinery is there so the next contributor with a genuine exception
documents it rather than widening the regex.

`src/app-layer/jobs` was swept at the same time and had no hits. It is
deliberately left out of scope: job inputs come from the scheduler and the
executor registry, not from a request.

The `riskTier` case is the one the widened scan still would not have found,
because the cast lived in `src/app/api`. Scanning route handlers is a
larger change than this fix warrants — a route legitimately casts many
things — so the ratchet is left where the value lands rather than where it
arrives. The structural defence against a repeat is the type: no filter
parameter on a repository or usecase signature should be declared as a
Prisma enum, because a caller can only satisfy that with a cast.

## What the sweep found and deliberately left

| Site | Why not changed |
| --- | --- |
| `agent-proposals.ts` — `proposal.kind as AgentProposalKind` | Narrows a row read back out of the DB after a `create`, not a wire value |
| `personnel.ts`, `dsar-register.ts`, `org-audit.ts` | Already validated upstream by a const-array allowlist (`includes` / `find` / `Set`), so no 500 is reachable. They do silently **drop** a comma-joined multi-select rather than 400 on it — a behavioural inconsistency with `parseEnumListFilter`, but a different (and much quieter) defect than the one this fix is about |
| `risk-scenario.ts`, `scanner-ingestion.ts`, `vulnerability.ts`, `business-impact-analysis.ts`, `framework/coverage.ts`, `framework/install.ts` | The column is `String` in the schema, not an enum. Prisma accepts anything; the worst case is zero rows, never a validation error |
| `AccessReviewRepository.ts`, `org-security-initiative.ts` | Latent — the enum-typed parameter exists but no caller passes it from a request |
| `mfa.ts`, `finding.ts`, `incident.ts`, `risk.ts`, `audit.ts`, `asset.ts`, `evidence.ts`, `audit-readiness/cycles.ts` | Enum casts on a **write** (`create` / `update` `data`), not a filter. Same `as`-hides-a-runtime-error shape and worth its own pass, but the failure mode, the fix, and the right guard all differ from a list filter |
| ~40 ` as never` / ` as unknown as ` hits across the usecase tree | `Json` column payloads and non-Prisma arguments; never an enum `where` |

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/due-planning.ts` | `listAllTestPlans` — the live 500; `TestPlanStatus` validated |
| `src/app-layer/usecases/agent-proposals.ts` | `listAgentProposals` — `SuggestionItemStatus` validated |
| `src/app-layer/usecases/framework-delta.ts` | `listTenantFrameworkDeltas` — `FrameworkDeltaStatus` validated; `REVIEWABLE_CONTROL_STATUSES` typed against `ControlStatus` |
| `src/app-layer/usecases/workflow-runs.ts` | `listWorkflowRuns` — `WorkflowRunStatus` validated |
| `src/app/api/t/[tenantSlug]/ai-systems/route.ts` | Drops the `as AiRiskTier` cast; passes the raw string through |
| `src/app-layer/usecases/ai-system.ts` | `listAiSystems` takes `riskTier?: string`, not the enum |
| `src/app-layer/repositories/AiSystemRepository.ts` | `riskTier` validated alongside the `status` filter fixed in #1763 |
| `tests/guards/list-filter-enum-cast.test.ts` | Ratchet widened to `usecases` + `services`; recursive walk; documented exemption map |
| `tests/unit/usecases/list-filter-enum-validation.test.ts` | **New.** Behavioural cover, mirroring the repository-layer sibling |
| `tests/unit/repositories/list-filter-enum-validation.test.ts` | Adds the two `AiSystemRepository` cases |

## Decisions

- **Assigned `status` unconditionally instead of spreading it in.** The
  three `as never` sites used `...(opts.status ? { status: … } : {})`; they
  now compute `status` once and pass it through, because
  `parseEnumListFilter` already returns `undefined` for an absent filter
  and Prisma treats an `undefined` `where` member as "not provided". One
  shape, no conditional, and the absent case is covered by the same test
  as the present one.
- **Widened the existing guard rather than adding a second one.** The bug
  is one class; splitting it across a repository ratchet and a usecase
  ratchet invites the two to drift, which is the same failure mode that let
  three copies of the parser grow before #1763. Layer membership was never
  the invariant — "a wire value reaching a Prisma enum column" is.
- **Shipped the exemption map empty.** A baseline map with zero entries
  looks like dead code, but the alternative is that the first contributor
  who needs an exception reaches for the cheaper escape (loosening the
  regex, renaming a variable out of the `filters|options|opts|params|query`
  set) and silently defeats the ratchet for everyone.
- **Left `proposal.kind as AgentProposalKind` alone.** It narrows a value
  read back *out* of the database after a `create`, where Prisma has
  already validated it. It is not a wire value, the scan does not match it
  (the receiver is not a filter bag), and the detector-proof test asserts
  that non-match explicitly so a future regex widening has to confront it.
- **Typed `REVIEWABLE_CONTROL_STATUSES` instead of `as never`-ing it at the
  call site.** It is a compile-time constant, not user input, so it is not a
  `parseEnumListFilter` site and does not need the runtime parse. But the
  `as never` was a pure compiler silencer over a `{ in: [...] }` on an enum
  column — exactly the shape that hid the four real bugs. Naming
  `ControlStatus` in the declaration makes a renamed or removed member a
  build failure rather than a runtime `PrismaClientValidationError`, and
  costs nothing.
- **400, not silently-empty.** Unchanged from #1763 and worth restating:
  matching zero rows reads to the user as "you have no test plans". Naming
  the bad value and the allowed set lets a stale bookmark be diagnosed from
  the response body.
