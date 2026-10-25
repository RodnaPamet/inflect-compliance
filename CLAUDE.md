# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Human contributors: start at [CONTRIBUTING.md](CONTRIBUTING.md).** This file is
> the LLM-assistant architecture spec — exhaustive domain context, not an
> onboarding path. `CONTRIBUTING.md` is the day-one guide; come back here for the
> deep dive.

> **Adding a new provider, tenant-scoped model, or background job?** Follow
> **[docs/new-subsystem-checklist.md](docs/new-subsystem-checklist.md)** — each
> item (fail-closed check semantics · two-tenant behavioural test · runtime
> wiring · outcome metric · authz gate) is backed by a structural ratchet that
> fails CI until satisfied. Structural ratchets certify *shape*; behavioural
> ratchets certify *conduct* — the platform enforces both.

## Working agreements (Claude Code sessions)

Operator-set workflow directives for how Claude drives changes in this repo
(set 2026-07-23 by the repo owner). These persist here because the remote
execution environment is ephemeral — only committed files survive.

- **Always open a PR after completing a prompt's work.** Once the branch has
  the finished commits pushed, open (or update) the PR for it — don't leave the
  work sitting on the branch. This overrides the default "don't open a PR unless
  asked" posture for this repo.
- **Merge all green PRs.** When a PR's required checks are all green, merge it
  (standing authorization — no per-PR confirmation needed). "Green" means every
  required check has completed successfully; a pending or failing required check
  is NOT green. Never bypass a red/failing check or admin-merge past CI — a
  blocked PR gets driven to green (fix the failure) or the blocker gets
  surfaced, never force-merged.
- **Do not hold a green PR for the owner's `Sign-off:`** (added 2026-08-18).
  This resolves an ambiguity against the SIGNIFICANT-change rule in
  [docs/change-management-policy.md](docs/change-management-policy.md): a green
  PR is merged even when it is SIGNIFICANT (schema migration, security
  middleware, dependency major bump). The owner waived the *wait*, not the
  diligence — still write the rollback plan and the risk assessment into the PR
  before merging, because that is the part that catches things. Worked example:
  #1963 (undici 7→8) was fully green and would have taken every SIEM
  audit-stream delivery and every automation webhook dark; the pre-merge read of
  the diff, not the green tick, is what found it.

  What "green" means is unchanged and remains the binding constraint: every
  required check PRESENT and successful, nothing pending, nothing failing.
  Verify by check NAME rather than a count — a check that never ran is
  indistinguishable from one that passed — and re-verify freshly rather than
  trusting an earlier read.

## Commands

```bash
# Development
npm run dev               # Start Next.js dev server
npm run build             # Validate env + build
npm run typecheck         # tsc --noEmit
npm run lint              # eslint . (flat config, eslint.config.mjs)

# Database
# The Prisma schema lives in a folder of 26 files, not a single file —
# base/enums/auth/vendor/audit-trail/audit-workflow/automation/processes plus
# the compliance-domain split (controls, evidence, risk, frameworks, policy,
# tasks, assets, personnel, findings, incidents, questionnaire, nis2,
# ai-governance, trust-center, agentic, analytics). See the Layer Structure
# section below and prisma/schema/README.md — `compliance.prisma` is an empty
# stub and `audit.prisma` no longer exists.
# Prisma reads every `.prisma` file in the folder and concatenates them at
# generate / migrate time — no flag needed (`prismaSchemaFolder` went GA in
# Prisma 6 and was removed as a preview feature in v7). See prisma/schema/README.md.
npm run db:generate       # Regenerate Prisma client after schema changes
npm run db:push           # Push schema to DB (no migration file)
npm run db:migrate        # Create + apply a named migration interactively
npm run db:reset          # Drop, recreate, and reseed the DB

# Tests
npm test                  # Jest (parallel)
npm run test:ci           # Jest (sequential, no coverage — used by scripts/ci-local.mjs; GitHub CI runs sharded `npx jest --shard=K/4`)
npm run test:coverage     # Jest with coverage report
npm run test:e2e          # Playwright browser tests

# Run a single Jest test file
npx jest tests/unit/golden-path.test.ts

# Run a single Playwright test file
npx playwright test tests/e2e/core-flow.spec.ts

# Docker (local dev stack — PostgreSQL + PgBouncer + Redis + ClamAV)
docker-compose up -d
```

## Production VM

The production deployment runs on a single GCP VM, and **Claude has
`gcloud` access to it** — project `hazel-design-419410`, instance
`inflect-compliance`, zone `europe-west1-b`:

```bash
gcloud compute ssh inflect-compliance --zone europe-west1-b --command "…"
```

The VM hosts a Docker Compose stack at `/opt/inflect/`
(`docker-compose.prod.yml`). Watchtower auto-updates only the
`app` + `worker` *images*, never Compose structure. Docker
commands on the VM need `sudo`. `/opt/inflect/.env.prod` and the
Redis `--requirepass` value are real secrets — never echo them,
and never `cat` the live compose file (it carries inline
credentials). Extract SHAPE instead: `sudo grep -oE
"^\s*[A-Z_]+:" <file> | sort -u`.

**The Compose file is repo-canonical (#2849) — do NOT hand-edit
the host copy.** `deploy/docker-compose.prod.yml` is the source of
truth; it reaches the VM through `deploy/apply.sh` (preflights by
default, `CONFIRM=1` applies) and divergence is reported by
`deploy/check-drift.sh`. Hand-editing `/opt/inflect/` is what
produced the ~148-line drift #2849 closed, and it makes the repo
file a trap for whoever reaches for version control mid-incident.
A structural change belongs in the repo file, in a PR, then
applied. See **`docs/deployment.md` → "The production VM's
Compose file is repo-canonical"** for the canonical set, the
`--env-file` vs `env_file:` distinction, and the outstanding
operator actions.

Non-structural VM work — inspecting container logs, a one-off job
run — is still fine to execute directly via `gcloud compute ssh`
rather than asking the operator.

## Architecture

### Framework baseline

**Next.js 16.3.8** (App Router) + **React 19.2** + **TypeScript 5.9** (declared `^5.5.0`).
The React 18 → 19 bump (#67) is complete: React 19 removed
`propTypes`, function-component `defaultProps`, string refs and
legacy context — the codebase carries none of those.
`forwardRef` still works in React 19 (which also accepts `ref` as a
plain prop); existing `forwardRef` call sites are fine and
modernising them is optional.
GAP-05 (2026-04-25) first migrated off the vulnerable `next@^14.2.0` line —
the two HIGH advisories (Image Optimizer DoS, RSC request
deserialization) were unfixable in 14.x. CI security gates restored
to their pre-workaround strictness, and on 2026-05-12 tightened one
further notch: npm audit blocks on **MODERATE+** (production deps),
Trivy blocks on `CRITICAL,HIGH` (container scan). The structural
ratchet at `tests/guardrails/security-gate-strictness.test.ts` fails
CI if either gate is silently re-lowered (`moderate` → `high` /
`critical`, or `CRITICAL,HIGH` → `CRITICAL`) or `next` is downgraded
back to 14.x.

Async-request-API: this migration is COMPLETE. Every dynamic route
handler types `params` as `Promise<…>` and awaits it itself (354 of
them; zero type it synchronously), and the transparent-await shim that
`src/lib/errors/api.ts::withApiErrorHandling` once carried was removed
in Roadmap-6 P3 — the wrapper now forwards `ctx` through untouched.
Unit tests that pass a plain sync `params` object still work, because a
migrated handler's `await params` resolves a non-thenable to itself.
`tests/guards/async-params-route-typing.test.ts` blocks a regression.
See `docs/implementation-notes/2026-04-25-gap-05-next15-migration.md`.

### Layer Structure

```
src/app/api/           → Next.js route handlers (HTTP boundary only — parse input, call usecases, return responses)
src/app-layer/usecases/→ Business logic orchestration (thin: validate → call policy → call repo → emit event)
src/app-layer/policies/→ Authorization checks (assertCanRead/Write/Admin/Audit) — always called before data access
src/app-layer/repositories/ → Prisma queries for tenant-scoped models (every query filters by tenantId). Org-scoped, SSO/MFA/SCIM and pre-membership flows use the global client from the usecase — see the allowlists in tests/unit/no-direct-prisma.test.ts
src/app-layer/jobs/    → BullMQ job definitions (background tasks)
src/app-layer/services/→ Cross-cutting domain services (library import, cross-framework traceability)
src/app-layer/events/  → Audit event writers (immutable, hash-chained audit trail)
src/lib/               → Shared infrastructure (auth, observability, storage, rate-limiting, permissions)
src/components/        → React components

prisma/schema/         → Multi-file Prisma schema (GAP-09):
                            base.prisma         — generator + datasource (sole owners)
                            enums.prisma        — every shared enum
                            auth.prisma         — Tenant/User/Membership/Session/SSO/Billing
                            vendor.prisma       — Vendor + assessment graph
                            audit-trail.prisma  — AuditLog/OrgAuditLog (hash-chained trail)
                            audit-workflow.prisma — Audit/Cycle/Pack/Auditor + ReadinessSnapshot
                            automation.prisma   — AutomationRule/Execution + Notification + Integration
                            processes.prisma    — Business-process canvas graph
                          compliance.prisma was split (2026-07-10) into domain-cohesive
                          files — pick the one matching the new model's cluster:
                            controls.prisma     — Control + coverage joins/tasks/templates/tests/exceptions
                            evidence.prisma     — Evidence + FileRecord + reviews
                            risk.prisma         — Risk + quant/analytics/reporting/treatment
                            frameworks.prisma   — Framework/Requirement refs, mappings, ISO clauses
                            policy.prisma       — Policy + versions/approvals/acks + links
                            tasks.prisma        — Task + its owned children
                            assets.prisma       — Asset + vuln/scanner chain + Asset↔Risk
                            personnel.prisma    — Employee/Device/Training/BackgroundCheck/identity
                            findings.prisma     — Finding + risk/evidence junctions
                            incidents.prisma    — Incident (NIS2 Art.23) + BIA
                            questionnaire.prisma— Inbound questionnaires + answer library
                            nis2.prisma         — NIS2 gap self-assessment
                            ai-governance.prisma— AI-gov self-assessment + EU AI Act registry
                            trust-center.prisma — Public trust-center projection + gated docs
                            agentic.prisma      — Agent-proposal queue + workflow engine
                            analytics.prisma    — Denormalised dashboard snapshots
                            compliance.prisma   — now an empty stub (do NOT add models here)
                            schema.prisma       — transitional sediment file (currently empty)
                          See prisma/schema/README.md and
                          docs/implementation-notes/2026-07-10-compliance-schema-split.md
                          for the seam rationale. Adding a new model: pick the matching
                          domain file (keep files ≤~30 models). Generator and datasource
                          ONLY live in base.prisma — Prisma rejects duplicates across the
                          folder. Enums ONLY in enums.prisma.
```

### Request Context (`RequestContext`)

Every usecase and repository receives a `RequestContext` (defined in `src/app-layer/types.ts`) containing `requestId`, `userId`, `tenantId`, `role`, `permissions`, and `appPermissions`. It is built once per request by `getTenantCtx()` in `src/app-layer/context.ts` and threaded EXPLICITLY as the first argument to every usecase and repository call — there is no AsyncLocalStorage for it. Separately, `getRequestContext()` from `src/lib/observability` returns `RequestContextData` (`requestId`, `tenantId?`, `userId?`, `route?`, `startTime`), which IS AsyncLocalStorage-propagated but carries no `role` / `permissions` / `appPermissions` — it is for logging and tracing only, never for authorization.

### Multi-Tenant Isolation

Two layers, both load-bearing:

1. **PostgreSQL Row-Level Security** (Epic A.1). Every tenant-scoped
   table has `tenant_isolation` + `superuser_bypass` policies and
   `FORCE ROW LEVEL SECURITY`. Tenant context is bound per-transaction
   via `runInTenantContext` from `@/lib/db/rls-middleware`. The DB
   returns zero rows if the context is unset on an `app_user`
   session — isolation is architecturally impossible to bypass by
   accident. **See `docs/rls-tenant-isolation.md`** for the full guide
   including the bypass model, the policy shapes for nullable /
   ownership-chained tables, and how to add a new tenant-scoped model.

2. **Application-layer `tenantId` filters** — every repository query
   also filters by `tenantId`. Defence in depth; makes error messages
   clear when the app is working correctly.

Guard tests: `tests/guardrails/rls-coverage.test.ts` (DB-backed — CI
fails if a tenant table is missing RLS) and
`tests/unit/tenant-isolation-structural.test.ts` (code-pattern scanner).

### API Rate Limiting (Epic A.2 + GAP-17)

Three tiers, each scoped to a different traffic class. Full operator
runbook in `docs/rate-limiting.md`.

**Mutation tier** (Epic A.2). Every route wrapped with
`withApiErrorHandling` gets `API_MUTATION_LIMIT` (60/min) on
POST/PUT/DELETE/PATCH by default. Stricter presets (`LOGIN_LIMIT`,
`API_KEY_CREATE_LIMIT`, `EMAIL_DISPATCH_LIMIT`) are applied via
`{ rateLimit: { config, scope } }` options on specific routes. Keyed `(scope, IP)` — the key shape is `<scope>:ip:<ip>:<actor>`, but `actor` is `anon` on every route except `agents/questions`, the only one that supplies the optional `getUserId` resolver, so co-NAT'd users share a budget. Storage: in-process Map (Node runtime).

`/api/mcp` replaces this tier with two budgets, because a hosted MCP client calls from its provider's egress addresses and an IP-keyed bucket would make every customer agent hosted there share one. Before authentication, `MCP_IP_CEILING_LIMIT` (600/min per IP, scope `mcp-ip`) is containment. After it, `MCP_PER_KEY_LIMIT` (60/min) is keyed on the VERIFIED `apiKeyId` with no IP, through `enforceApiKeyRateLimit`, and charged per JSON-RPC message, all or nothing, so a batch cannot carry more than a minute's budget. It is charged BEFORE the invocation is built (`verifyMcpCredential`, then the charge, then `completeMcpAuthentication`): building it sends a live `tools/list` to every external connection the agent is granted, and a malformed request is charged one unit and builds nothing (#4205). Never key a budget on a digest of a presented token after the fact: it is the value an unauthenticated caller varies.

**Read tier** (GAP-17). Tenant-scoped GETs on `/api/t/<slug>/...` go
through `API_READ_LIMIT` (120/min) at the Edge middleware via
`src/lib/rate-limit/apiReadRateLimit.ts`. Keyed `(IP, userId,
tenantSlug)` for per-tenant + per-user isolation. Health probes
(`/api/health`, `/api/livez`, `/api/readyz`) and `/api/docs` are
explicitly excluded — operators must keep monitoring access during
attacks. Storage: Upstash + memory fallback (mirrors `authRateLimit.ts`).
The wire-up sits AFTER the JWT verify + tenant-access gate so
unauthorized requests get the cheaper 401/403 first; structural
ratchet at `tests/guardrails/api-read-rate-limit.test.ts` enforces
the ordering + exclusion list.

**Auth tier** (covered separately by `src/lib/rate-limit/authRateLimit.ts`).
Tiered per-endpoint policy at the Edge: 10/min for sign-in callbacks,
30/min for session probes, 60/min for csrf/providers. Keyed `(IP,
ua-hash)` because it runs pre-authentication.

429 responses carry `Retry-After` + `X-RateLimit-*`; the mutation- and read-tier 429s also carry `x-request-id`. The auth-tier 429 does NOT — `middleware()` returns it early (src/middleware.ts, the `/api/auth/` block) before the request-id header is stamped on the response.
Body never contains IP/userId/tenantSlug. Bypass via
`RATE_LIMIT_ENABLED=0` env or inside tests (automatic). All presets
live in `src/lib/security/rate-limit.ts`; the Node wrapper is
`src/lib/security/rate-limit-middleware.ts`; the edge enforcement
modules live under `src/lib/rate-limit/`.

### Auth Brute-Force Protection (Epic A.3)

`authenticateWithPassword` applies `LOGIN_PROGRESSIVE_POLICY`:
3 failures → 5s delay, 5 → 30s, 10 → 15-min lockout. Timing is
equalised via `dummyVerify` so lockout is indistinguishable from
wrong-password. Signup rejects known-breached passwords via
`checkPasswordAgainstHIBP` (k-anonymity, fail-open on HIBP outage).

**Password change + reset.** Three routes under `/api/auth/`:
`change-password` (authenticated — verifies the current password),
`forgot-password` (issues a token, enumeration-safe), and
`reset-password` (consumes the token). Reset tokens are
`SHA-256`-hashed at rest in `PasswordResetToken`, single-use
(conditional-`updateMany` claim), and expire after 1 hour. Both
set-password routes run `validatePasswordPolicy` + the HIBP check;
every success revokes ALL of the user's sessions (`sessionVersion`
bump + `UserSession.revokedAt`). Logic lives in
`src/lib/auth/password-management.ts`. Any future password-accepting
route MUST wire HIBP the same way — the Epic E.4 guardrail enforces
it.

**See `docs/epic-a-security.md`** for the unified operator runbook
(verification commands, rollback procedure, observability signals)
and `docs/rls-tenant-isolation.md` for the RLS deep dive.

### Field Encryption (Epic B)

Business-content fields (Finding.description, Risk.treatmentNotes,
PolicyVersion.contentText, TaskComment.body, …) are encrypted at
rest by a Prisma `$extends` query extension. The wiring is
`withEncryptionExtension` in `src/lib/db/encryption-middleware.ts`,
composed onto the client in `src/lib/prisma.ts` (Prisma 7 removed
`$use`; `registerEncryptionMiddleware` survives only as a deprecated
no-op stub for legacy test imports). The manifest lives in
`src/lib/security/encrypted-fields.ts`; **never** add or remove
encrypted columns outside it. Add a model here ⇒ its manifest
fields encrypt on every write and decrypt on every read
transparently.

Key hierarchy: `DATA_ENCRYPTION_KEY` (master KEK) wraps a per-tenant
DEK on `Tenant.encryptedDek`. New tenants get a DEK at creation via
`createTenantWithDek` (from `src/lib/security/tenant-key-manager.ts`);
existing tenants get one via `scripts/generate-tenant-deks.ts`.
Ciphertexts carry `v1:` (global KEK, legacy) or `v2:` (per-tenant
DEK) envelope — the middleware dispatches per-value on read.

**GAP-03 — production fail-fast.** The master KEK is REQUIRED in
production. Three independent checks each refuse to start a prod
process whose `DATA_ENCRYPTION_KEY` is missing, shorter than 32
chars, or equal to the documented dev fallback:

  1. zod schema in `src/env.ts` — fires at module load, `superRefine`
     on the field reads `process.env.NODE_ENV` directly.
  2. startup hook in `src/instrumentation.ts` (web) +
     `scripts/worker.ts` (BullMQ worker) + `scripts/scheduler.ts`
     (deploy-time scheduler) — exits 1 with `[startup] FATAL: …`.
     The web and worker tiers additionally run an encrypt → decrypt
     sentinel (`runEncryptionSentinel`) to catch keys that pass
     structural checks but break HKDF/AES; the scheduler runs the
     presence check only.
  3. Compose `:?error` syntax in `docker-compose.prod.yml` /
     `docker-compose.staging.yml` / `deploy/docker-compose.prod.yml`
     — aborts container start before the app process is spawned.

Dev gets the in-source fallback key (`encryption-constants.ts`) with
a WARN log on every server start; test gets the same fallback
silently. The fallback is well-known + refused in prod, not secret.
The runtime + structural enforcement is unit-tested in
`tests/unit/security/startup-encryption-check.test.ts` +
`tests/unit/env.test.ts`, and the wiring across all five surfaces
is locked by `tests/guardrails/encryption-key-enforcement.test.ts`.

Master-KEK rotation: set `DATA_ENCRYPTION_KEY_PREVIOUS` alongside
the new primary. `decryptField` falls back transparently. Admins
trigger the v1→v2 re-encryption sweep via
`POST /api/t/{slug}/admin/key-rotation`, which enqueues the
background job in `src/app-layer/jobs/key-rotation.ts`. The job
re-encrypts every `v1:` ciphertext under the new primary KEK and
re-wraps the per-tenant DEK. When every tenant reports zero `v1:`
rows under the old key, remove `DATA_ENCRYPTION_KEY_PREVIOUS` from
env.

Per-tenant DEK rotation (generating a fresh DEK for a single
compromised tenant without touching the global KEK) is implemented
at `rotateTenantDek` in `src/lib/security/tenant-key-manager.ts`.
The admin surface is `POST /api/t/:slug/admin/tenant-dek-rotation`,
gated by `admin.tenant_lifecycle` (OWNER-only). The flow:
atomic UPDATE moves the old wrapped DEK into
`Tenant.previousEncryptedDek` and writes a fresh wrapped DEK to
`Tenant.encryptedDek`; the response is 202 + a job id for the
`tenant-dek-rotation` BullMQ sweep that re-encrypts every v2
ciphertext under the new DEK and clears `previousEncryptedDek` on
completion. Mid-flight reads remain correct via
`decryptWithKeyOrPrevious` in the encryption layer — primary first,
fall back to previous on AES-GCM auth failure. The per-tenant DEK
fallback is locked in by
`tests/guardrails/tenant-dek-rotation-fallback.test.ts`.

**See `docs/epic-b-encryption.md`** for deployment order,
rotation runbook, observability signals, rollback procedure, and
the full test coverage map.

### Defense-in-Depth (Epic C)

Five complementary controls. Treat them as one system — each
sub-epic has the others as backstops.

**Runtime DAST layer (OWASP ZAP).** Alongside the *static* gates
(CodeQL SAST, Trivy container CVEs, npm audit) there is now a *dynamic*
one: the nightly `.github/workflows/dast.yml` boots the full app +
Postgres + Redis and runs an OWASP **ZAP Baseline** (passive) scan,
publishing SARIF to the Security tab (one analysis per role,
`category: zap-baseline-<role>`) + an HTML artifact + an auto-issue.
The scan is **authenticated and multi-role** — a matrix logs in as each
seeded role (owner / editor / reader / auditor) through the real
NextAuth credentials flow and scans that role's reachable surface. Note
that is per-role PASSIVE surface coverage, NOT broken-access-control
detection; BAC is enforced and tested at the app layer.

The weekly **active** scan has also shipped, as
`.github/workflows/dast-full.yml` (Sundays 05:00 UTC, OWNER session,
SARIF `category: zap-full`).

The nightly baseline is **BLOCKING** since 2026-08-29 (`fail_action:
true`, `continue-on-error` removed) — the 2026-07-24 sunset had lapsed
36 days, and the flip was evidenced against the downloaded report JSON
of three nightlies plus one weekly: zero un-allowlisted alerts, zero
HIGH+, highest observed risk Medium. Removing `continue-on-error`
matters beyond findings: `action-baseline` calls `core.setFailed` on
zap-baseline.py exit 3 ("could not scan the target") REGARDLESS of
`fail_action`, so it was also masking a scan that never ran as a green
nightly. The weekly ACTIVE scan stays non-blocking on a real dated
deferral (it mutates requests and has a younger baseline), but its
HIGH+ gate runs today.

The guard no longer accepts a non-blocking scan silently: a deferral
must carry `DAST-NON-BLOCKING-UNTIL: <YYYY-MM-DD>`, which
`tests/guardrails/dast-workflow-pinning.test.ts` PARSES and compares
against the current date. The previous check only asserted that some
date-shaped string existed beside `fail_action: true`, so no passage of
time could turn it red — the missed flip was the symptom, that was the
defect. The false-positive allowlist is `.zap/rules.tsv`, shared by
both workflows; note an `IGNORE` there silences a pluginId at EVERY
risk level, so `.zap/assert-no-high-risk.mjs` reads ignored alerts too
and fails on riskcode>=3 whether allowlisted or not.
See **`docs/dast.md`**. Guarded by
`tests/guardrails/dast-workflow-pinning.test.ts`.

**C.1 — API permission middleware.** Wrap every privileged API
handler with `requirePermission(<key>, …)` from
`@/lib/security/permission-middleware`. The key is a typed dotted
literal (`'admin.scim'`, `'risks.create'`, …) derived from
`PermissionSet`. Denials emit a hash-chained `AUTHZ_DENIED` audit
entry (`category: 'access'`) and surface as a generic 403 — the
key itself is never echoed to the client. The route ↔ map sync is
guarded by `tests/guardrails/api-permission-coverage.test.ts`;
new admin/privileged routes MUST add a rule in
`src/lib/security/route-permissions.ts` and use
`requirePermission(...)`. The legacy `requireAdminCtx` /
`requireWriteCtx` / `requireRoleCtx` helpers no longer exist — they were
removed on 2026-05-21 and `tests/guardrails/no-legacy-admin-guard.test.ts`
keeps them from returning.

**Two layers, and they are not interchangeable.**
`api-permission-coverage.test.ts` is LAYER 1 — a curated
`PRIVILEGED_ROOTS` population where only a LITERAL
`requirePermission(...)` in the route file counts. A usecase-layer
`assertCan*` does NOT satisfy it and must never be allowed to: a
`requirePermission` denial writes a hash-chained `AUTHZ_DENIED`
row, an `assertCanAdmin` denial writes nothing. Accepting the
weaker mechanism on that population was measured, once, at a net
strictness regression across 25 routes.

`tests/guardrails/api-route-has-some-authorization.test.ts` is
LAYER 2 (#2099) — additive, over ALL 582 `src/app/api/**/route.ts`
files. It asks only *"is there any authorization on this path at
all?"*, satisfied by a route-level gate, an `assertCan*` reached
through the call graph (`tests/helpers/route-authorization-graph.ts`,
3 module hops), or a declared exempt class whose credential check
CI still verifies is present. **It makes no ordering, sufficiency
or liveness claim** — a check that runs after the destructive
write passes it. The residual with no authorization at all is
ZERO, pinned by exact equality — both original members were fixed
rather than reclassified (#2109 csp-report GET, #2108 avatar reads),
and a route reaching that bucket is a finding to fix, not an entry to
add. A new route lands
IN by default: adding one under an existing exempt prefix still
fails until it is triaged. See
`docs/implementation-notes/2026-08-22-api-authorization-two-layers.md`.

**C.2 — Secret detection.** Local pre-commit hook
(`.husky/pre-commit` → `scripts/detect-secrets.sh`) scans staged
files; CI guardrail (`tests/guardrails/no-secrets.test.ts`) walks
the whole tree. Both load patterns from `.secret-patterns` (one
source of truth). Carve-outs: inline
`// pragma: allowlist secret` for one-off lines, or move fixtures
under `tests/fixtures/secrets/` (auto-skipped). Pre-existing
placeholder fixtures live in `REPO_BASELINE` in the guardrail; add
to that array only with a written `reason`.

**C.3 — Session hardening.** A `UserSession` row is minted on every
sign-in (NextAuth `jwt` callback → `recordNewSession`) carrying
`ipAddress`, `userAgent`, `expiresAt`, `lastActiveAt`. Every JWT
pass calls `verifyAndTouchSession`. A revoked or expired row makes the
callback THROW `SessionRevokedError` (`src/lib/auth/session-revoked.ts`), and
NextAuth then treats the session as invalid: `getServerSession` / `auth()`
return `null`, so every server gate refuses it. It used to return the token
with `error: 'SessionRevoked'` and every claim intact, and nothing read the
flag, so no revocation signed anybody out. Never go back to flagging. The
throw must also sit outside the fail-open `try`, or a revocation is swallowed
as a telemetry failure. Per-tenant policy lives on
`TenantSecuritySettings.maxConcurrentSessions` (overflow → revoke
oldest by `lastActiveAt` ASC) and `sessionMaxAgeMinutes` (caps
`expiresAt` at insert time). The admin UI lives at
`/admin/members` — Sessions column + modal + per-row revoke,
backed by `GET/DELETE /api/t/:slug/admin/sessions`. "Sign Out Other
Sessions" (`security/sessions/revoke-current`) stamps the caller's
OTHER `UserSession` rows and keeps the one named by the request JWT's
`userSessionId` (#4117); it bumps `User.sessionVersion` only when that
session cannot be identified. Revoke All (`revoke-all`, ACTIVE members
only, the caller's current session kept) and per-user revocation bump
`sessionVersion` AND stamp the rows — the version bump stays the
coarse-grained backstop for a token whose row was never written. Signing
ONE person out — per-user or one device — of an OWNER or AI_ADMIN needs
`admin.owner_management`, as deactivating one does
(`assertMayRevokeSessionsOf`, `REVOKING_OWNER_MANAGED_SESSIONS_IS_OWNER_TIER`;
owner decision, 2026-10-25); Revoke All does not ask it, being the incident
lever.

**C.4 — Audit event streaming.** Every committed audit row is
fired through `streamAuditEvent` into a per-tenant in-memory
buffer (lazy-imported by `appendAuditEntry` so cold-start cost is
zero for tenants without streaming configured). Flush happens on
100 events OR 5 seconds, HMAC-SHA256-signed
(`X-Inflect-Signature: sha256=<hex>`), POSTed to
`TenantSecuritySettings.auditStreamUrl`. The HMAC secret is on
the same row (`auditStreamSecretEncrypted`), encrypted at rest via
the Epic B field-encryption manifest. Fail-safe — the audit row is
already committed, so a broken SIEM never undoes the write.
Privacy-aware payload — free-text `details` is dropped, only
structured `detailsJson` ships; actor is opaque `userId` +
`actorType`, never email. Each batch delivery gets up to 3 attempts
(original + 2 retries) with linear backoff (1 s, 2 s). Kill-switch
via `AUDIT_STREAM_RETRY_ENABLED=0`.

**C.5 — Server-side rich-text sanitisation.** Use
`sanitizeRichTextHtml` / `sanitizePlainText` /
`sanitizePolicyContent` from `@/lib/security/sanitize` BEFORE
persisting any user-supplied rich-text. Already wired into
`policy.createPolicy`, `policy.createPolicyVersion` and
`task.addTaskComment` (the former `issue.addIssueComment` was deleted
with the retired `/issues` routes), plus the further write paths
enumerated in `RICH_TEXT_COVERAGE` in
`tests/guardrails/sanitize-rich-text-coverage.test.ts`. New write paths
that accept HTML or comment text MUST sanitise at the usecase
layer (not just at render time) — render-time sanitisation alone
would leave the row dangerous to PDF export, audit-pack share
links, and future SDK consumers reading the row verbatim. The
allowlist (tags, attributes, link schemes) is in
`src/lib/security/sanitize.ts`; do not widen it without a security
review.

**See `docs/epic-c-security.md`** for the unified operator
runbook (env vars, verification commands, rollback procedures,
failure modes) and `SECURITY.md` for the responsible-disclosure
policy.

### Isolation & Sanitisation Completeness (Epic D)

Epic D closed three concrete gaps left after Epic C. Each is now
guarded by a CI ratchet so the regression surface is small.

**D.1 — `UserSession` RLS.** The Epic C.3 `UserSession` table
shipped without RLS policies. It now carries a single asymmetric
`tenant_isolation` policy (`USING (tenantId IS NULL OR own) WITH
CHECK (own)`) plus the canonical `superuser_bypass`, with `FORCE
ROW LEVEL SECURITY` enabled. The single-policy form is mandatory
because `tenantId` is nullable: a split `tenant_isolation_insert`
policy would be a permissive sibling that lets `app_user` UPDATE a
NULL row to any tenantId. `UserSession` is listed in
`SINGLE_POLICY_EXCEPTIONS` in `tests/guardrails/rls-coverage.test.ts`,
where the post-loop sanity check verifies the asymmetric `qual` +
`with_check` shape is real — a future "simplify" PR that strips
either clause fails CI. See migration
`prisma/migrations/20260423150000_epic_d1_user_session_rls/` and
`tests/integration/user-session-rls.test.ts` for the seven
behavioural assertions (own-INSERT accepts; foreign-INSERT rejects;
NULL-INSERT-under-app_user rejects; NULL-row-claim-to-other-tenant
rejects; etc.).

**D.2 — Encrypted-field write paths sanitised.** Five usecase
files (`finding`, `risk`, `vendor`, `audit`, and the control-test-plan
usecase now at `usecases/control/test-plans.ts`) wrote
to encrypted free-text columns without server-side sanitisation.
Encryption protects confidentiality at rest; sanitisation protects
every downstream renderer (UI, PDF export, audit-pack share link,
SDK consumer reading the row verbatim) that decrypts and reads the
field. All five now route user-supplied free text through
`sanitizePlainText` (or, for surfaces that share the call shape,
the per-file `sanitizeOptional` helper that preserves the
undefined/null/string three-state contract). The
`tests/guardrails/sanitize-rich-text-coverage.test.ts` ratchet has
no numeric floor any more: it derives the rich-text inventory from
`ENCRYPTED_FIELDS` in `src/lib/security/encrypted-fields.ts` and fails
unless every encrypted business-content model is classified in exactly
one of `RICH_TEXT_COVERAGE`, `NON_RICH_TEXT_MODELS` or the ratcheting
`KNOWN_UNCOVERED`. A new encrypted free-text column therefore fails CI
until somebody sanitises it or writes down why it need not be. The
companion
`tests/unit/security/sanitize-write-paths.test.ts` carries 19
write-path assertions — one positive XSS-strip per call site.

**D.3 — Legacy `requireAdminCtx` migrated to `requirePermission`.**
Seven tenant API routes (billing × 3, security/sessions × 2,
security/mfa/policy PUT, sso) used the legacy role-tier guard,
which threw a 403 but **did not write an `AUTHZ_DENIED` audit
row** and was invisible to the Epic C.1 permission guardrail. All
seven now use `requirePermission(...)` — denials audit cleanly,
and `tests/guardrails/api-permission-coverage.test.ts` now treats
`billing/`, `sso/`, and `security/` as privileged roots with five
self-service routes (own MFA enrolment, own session revocation)
explicitly listed in `EXCLUDED_ROUTES` with written reasons. The
canonical pattern for new admin routes is
`requirePermission('<key>', handler)` — now the *only*
admin-authorization guard: the legacy `requireAdminCtx` /
`requireWriteCtx` / `requireRoleCtx` helpers were removed
(2026-05-21) once every route had migrated, and the ratchet
`tests/guardrails/no-legacy-admin-guard.test.ts` keeps them from
returning.

**See `docs/epic-d-completeness.md`** for the Epic D operator
runbook (verification commands, rollback procedures, the five
self-service security carve-outs, the asymmetric-RLS rationale).

### Observability & Operational Hardening (Epic E)

Three remediations that close the operational gaps left after Epic D.
Treat them as one subsystem — each protects a different blast-radius
class for the same deploy event.

**E.2 — Audit-stream retry + idempotency key.** `deliverBatch` in
`src/app-layer/events/audit-stream.ts` now attempts each batch up
to 3 times (original + 2 retries) on `408 / 429 / 5xx / network
throw`. Linear backoff (1 s, 2 s). Every attempt carries the SAME
`X-Inflect-Batch-Id` header — deterministic from
`(tenantId, schemaVersion, eventIds)` via `computeBatchId` in
`src/app-layer/events/webhook-headers.ts`. The same id doubles as
`X-Inflect-Idempotency-Key`, so consumer SIEMs dedupe retries with
zero retry-aware code on our side. Kill-switch via
`AUDIT_STREAM_RETRY_ENABLED=0` (force single-POST for debugging a
misbehaving SIEM without redeploy). Delivery is fully instrumented
with OTel metrics — `deliverBatch` calls `recordAuditStreamDelivery`
once per batch (success/failure counter + an attempts histogram for
retry pressure + a duration histogram), `streamAuditEvent` calls
`recordAuditStreamBufferOverflow` when a per-tenant buffer sheds an
event at the hard cap, and an `audit_stream.buffer.depth` observable
gauge reports backlog. Audit-stream failures deliberately do NOT
gate `/api/readyz` — the path is out-of-band + fail-safe (the audit
row is already committed); escalation is alert-based on the metrics.
See `docs/implementation-notes/2026-05-21-audit-stream-observability.md`.

`webhook-headers.ts` is the canonical module for any future outbound
webhook in the repo (SCIM push, billing fanout, per-tenant SIEM
pluralisation). Every caller uses `buildOutboundHeaders(...)` and
`computeBatchId(...)` — never spell `X-Inflect-*` header names
inline, never hand-roll dedupe keys.

**E.3 — Graceful shutdown.** On a rolling deploy the process receives
SIGTERM. Without a drain handler, three observability surfaces lose
data: per-tenant audit-stream buffers (irreversible — events never
reach the SIEM), OTel span batches still in the `BatchSpanProcessor`,
and Sentry errors still in the transport queue.
`installShutdownHandlers()` in `src/lib/observability/shutdown.ts`
drains all three in the order most-to-least critical for audit
correctness: audit buffers first, then OTel, then Sentry. Each stage
is `Promise.race`'d against its per-stage budget from
`src/lib/observability/shutdown-budget.ts` so a slow exporter never
blocks past the container's grace period (k8s default 30 s). The
three stage budgets (3 s + 2 s + 2 s = 7 s) fit under the 20 s
ceiling — leaving 10+ s for Next.js's own HTTP-drain handler
running in parallel. The handler never calls `process.exit` —
`next start` owns the process lifecycle. Registration happens in
`src/instrumentation.ts::register()`, after all `init*` calls, and
is idempotent under HMR via a module-level flag. SIGINT gets the
same treatment. A second SIGTERM falls through to Node's default
(via `process.once`) so an escalating runtime can always terminate.

Paired shutdown helpers live beside their init counterparts:
`shutdownTelemetry` in `src/lib/observability/instrumentation.ts`,
`shutdownSentry` in `src/lib/observability/sentry.ts`. Both are
bounded, idempotent, never throw — the handler composes them as
stable contracts.

**E.4 — HIBP guardrail.** `tests/guardrails/hibp-coverage.test.ts`
locks in the invariant that every API route ingesting a
user-chosen password MUST import AND call
`checkPasswordAgainstHIBP`. Mirrors the
`sanitize-rich-text-coverage.test.ts` template: a curated
`HIBP_REQUIRED_ROUTES` list (`auth/register`, `auth/change-password`,
`auth/reset-password`) paired with a structural scan of
`src/app/api/**/route.ts` for password-shaped Zod fields. An
in-memory mutation regression proof confirms the detector catches
removals. The structural scan auto-fails any new route that parses
a `password` / `newPassword` / `currentPassword` Zod field without
registering — define password schemas inline in the route file so
the scan sees them.

**See `docs/epic-e-observability.md`** for the Epic E operator
runbook (verification commands, rollback procedures, how to add a
new password-handling route, how to add a new outbound webhook).

### Finishing Touches (Epic F)

Small, independent remediations that close the long tail after
Epic E. Each landed as a focused PR; treating them as one "epic"
was purely a scheduling convenience.

**F.2 — `rotateTenantDek` reserved (since superseded).** Originally
landed as a stub at
`src/lib/security/tenant-key-manager.ts::rotateTenantDek(tenantId)`
that threw a runbook-carrying error pointing at the master-KEK
rotation workaround. The reservation included a new
`Tenant.previousEncryptedDek String?` column from migration
`20260424010000_add_tenant_previous_encrypted_dek`, paired with a
CHECK constraint (`previousEncryptedDek IS NULL OR !=
encryptedDek` — silent key-mixing guard) and a partial index for
the eventual sweep-rotations query.

The real implementation has since landed (see the "Field
Encryption" section above). The reservation paid off: the
implementation slotted in without a schema change and without any
caller-signature break (the function now takes an options object
instead of a single id; the only previous caller was the stub
test itself). Integration test renamed to
`tests/integration/tenant-dek-rotation.test.ts` — happy-path swap
+ double-rotation rejection + the original CHECK-constraint
assertion preserved verbatim.

**F.3 — `HttpMethod` union + sentinel comment.** The route
permission matcher previously did
`rule.methods.map((m) => m.toUpperCase()).includes(upperMethod)`
per gated-route request. The new `type HttpMethod = 'GET' | 'POST'
| 'PUT' | 'PATCH' | 'DELETE'` union enforces uppercase at compile
time, so the hot path drops the `.map(...)` allocation.
Ratchet: `tests/guardrails/route-permissions-uppercase.test.ts`
catches `as` casts, lowercase union-member additions, and type
widening back to `readonly string[]`. Separately, `encryption.ts:141`
now carries a three-state sentinel comment explaining that
`_lastPreviousKeySource: string | null | undefined` uses all three
states deliberately (undefined = never checked, null = checked-no-key,
string = checked-with-key-source).

**F.4 — SECURITY.md + detect-secrets.** `SECURITY.md` now documents
GitHub Security Advisories as the private-by-default primary
reporting channel (no fabricated security email). `scripts/detect-secrets.sh`
uses `git diff --cached --name-only --diff-filter=ACMR` so renamed
files with staged secrets still get scanned.

**See `docs/epic-f-finishing-touches.md`** for the Epic F operator
runbook (verification commands, rollback procedures, how to add a
new DEK-lifecycle verb to `tenant-key-manager`).

### Access Control & Tenant Onboarding (Epic 1)

Closes the audit's GAP-01 (Critical): OAuth sign-in no longer
silently grants ADMIN on the oldest tenant. Authentication and
tenant membership are now orthogonal — sign-in alone authenticates
the user; tenant access requires an explicit grant via one of the
allowlisted paths.

**Role model.** The `Role` enum has six values:
`OWNER | ADMIN | EDITOR | READER | AUDITOR | AI_ADMIN`. OWNER is strictly
superior to ADMIN — it gains `admin.tenant_lifecycle` (delete
tenant, rotate DEK, transfer ownership), `admin.owner_management`
(invite/remove OWNERs, assign OWNER role) and `admin.agent_ownership`
(own and receive an agent by transfer). ADMIN has every other
admin flag but explicitly denies those three. The `PermissionSet`
resolution in `src/lib/permissions.ts` hard-codes the distinction: the
`ADMIN` branch of `getPermissionsForRole` returns
`tenant_lifecycle: false, owner_management: false, agent_ownership: false`
explicitly. That is a value guarantee, not a type-level one (the declared
field type is `boolean`), so the custom-role path — which CAN express those
flags — is re-checked at runtime by `permissionsExceeding`.

`AI_ADMIN` (#3699) runs the agent register and can own and receive agents: the
seven agent keys (`AGENT_ADMIN_KEYS` — register, tool exposure, policy card,
kill switch, external tools, harness ingest, agent ownership) on top of
READER's set, and NONE of the tenant-wide admin keys (no `view`, `manage`,
members, SSO, SCIM, lifecycle, owner management or DSAR). It sits on READER's
rung of the coarse ladder (`ROLE_ORDER`), so `canWrite`/`canAdmin` are false
and no usecase gated on the coarse tier alone admits it; the agent usecases'
floor is `assertAgentGovernanceWrite` / `…Admin`
(`src/app-layer/policies/agent-governance.policies.ts`) — the coarse tier OR
the agent key the route requires, a strict superset of the floor it replaced.
It is declared LAST in the enum because three job actor pickers sort
`TenantMembership.role` ascending to find the most senior member, and it must
never sort ahead of ADMIN. **It has exactly two writers** (deploy 2): an OWNER
on the members page, moving an existing member in or out (`MEMBER_ROLE_CHANGE_ROLES`
+ `OWNER_MANAGED_ROLES` — an ADMIN can do neither), and an Entra group mapping an
OWNER made, at sign-in and on a SCIM Groups push. Every other writer reads
`ASSIGNABLE_TENANT_ROLES` (`src/lib/roles.ts`), which still excludes it, and
`tests/unit/ai-admin-role-writers.test.ts` holds the census.

**Membership creation is explicit.** Eight allowlisted paths can write a
`TenantMembership` row today:
(a) `redeemInvite` in `src/app-layer/usecases/tenant-invites.ts` —
token-bound, email-bound, atomically consumed via an `updateMany`
with `acceptedAt IS NULL AND expiresAt > now()` predicate. A leaked
token is burnt on email mismatch.
(b) `createTenantWithOwner` in `src/app-layer/usecases/tenant-lifecycle.ts` —
platform-admin tenant bootstrap, gated by `PLATFORM_ADMIN_API_KEY`
(constant-time compared via `verifyPlatformApiKey`).
(c) `/api/auth/register` — credentials self-service signup. It is NOT `AUTH_TEST_MODE`-gated: the route carries no such gate and the Credentials provider is always registered (`src/auth.ts:342-349`), so a self-registered production account is usable. Its only throttle is `TENANT_CREATE_LIMIT` (5/hour). Whether public signup should be open is an open product decision — see the note at the top of `src/app/api/auth/register/route.ts`.
Plus the legitimate SSO + SCIM provisioning paths, the two Epic O-2 org
paths (`org-provisioning.ts` fans ADMIN rows into every tenant under an
org for an existing ORG_ADMIN; `org-tenants.ts::createTenantUnderOrg`
writes the OWNER row), and the staging-only seed route. Every site is
allowlisted in `tests/guardrails/no-auto-join.test.ts` with a
one-line reason; a ninth-not-listed site fails CI. `OrgMembership` has
its own `ALLOWLISTED_ORG_MEMBERSHIP_SITES` list in the same file.

**Middleware tenant-access gate.** `/t/:slug/**` and
`/api/t/:slug/**` require the URL's slug to appear in the JWT's
`memberships[]` array — R-1 replaced the old single-slug `tenantSlug`
check, so a multi-tenant user passes for any tenant they hold. Mismatch → `/no-tenant` (web) or `403 cross_tenant_access_denied`
(API); a user with no memberships at all gets `/no-tenant` or
`403 no_tenant_access`. Uses the JWT claim only — no per-request DB hit. Carve-outs
for `/invite/<token>`, `/api/invites/**`, and `/no-tenant` itself.
Logic lives in `src/lib/auth/guard.ts::checkTenantAccess`.

One more carve-out, and it is a credential rather than a path (#2224): a
request to `/api/t/**` carrying `Authorization: Bearer iflk_…` falls
through at the edge before this gate — it has no cookie for the gate to
read, and `getToken()` returns null for an API key, which is what 401'd
the entire documented partner flow for its whole life. The bypassed check
moves into the handler: `getTenantCtx` refuses a key whose tenant is not
the slug in the URL. `matchTenantApiKeyRequest` in `guard.ts` is the
recogniser, and it is deliberately narrow — `/api/t/**` plus an `iflk_`
Bearer, nothing else, because the fall-through also skips the admin-role
and MFA gates. The edge never decides whether a key is REAL; the handler
does (`tryApiKeyAuth` throws 401 rather than falling back to the cookie).

**Last-OWNER protection — two layers.** Usecase layer
(`updateTenantMemberRole`, `deactivateTenantMember`, `removeTenantMember`)
counts ACTIVE OWNERs and throws `forbidden('Cannot demote/deactivate the last
OWNER...')`. DB trigger `tenant_membership_last_owner_guard` is the
backstop — raises SQLSTATE P0001 on any UPDATE or DELETE that would
leave a tenant with zero ACTIVE OWNERs, catching bypass attempts
(raw `deleteMany`, code paths that forget the check). The two-step
`transferTenantOwnership` flow uses this: promote the new OWNER
first (count=2), then demote the old (count=1, trigger satisfied).

**Invitation flow.** Admin POSTs to `/api/t/:slug/admin/invites` →
`createInviteToken` creates a 256-bit base64url token with 7-day
expiry. User clicks `/invite/<token>` → preview page → "Sign in to
accept" sets a 10-min HttpOnly cookie and redirects to `/login`.
After OAuth, the signIn callback reads the cookie and calls
`redeemInvite`. Step 1 (atomic claim) commits standalone so
Step 2 (email binding) can burn the invite on mismatch without
rolling back the claim — leaked tokens are unusable on first failed
attempt.

**See `docs/epic-1-access-control.md`** for the Epic 1 operator
runbook (verification commands, rollback procedures, how to add a
new tenant-membership creation path).

### RBAC & Permissions

- `src/lib/permissions.ts` — `PermissionSet` (granular UI flags) resolved from the user's role
- Built-in roles: `OWNER`, `ADMIN`, `EDITOR`, `READER`, `AUDITOR` (Prisma enum `Role`)
- Custom roles: `TenantCustomRole` model with `permissionsJson` overrides, referenced via `TenantMembership.customRoleId`
- `appPermissions` on `RequestContext` is already custom-role–aware
- **An OWNER or AI_ADMIN membership never carries a custom role** (#3720, #3699).
  A custom role REPLACES the membership's permissions, so on an OWNER it was a
  demotion an ADMIN could perform while the enum role — and so every last-OWNER
  check — still read OWNER. `BUILT_IN_SCOPE_ROLES` / `mayCarryCustomRole` in
  `src/lib/roles.ts` is read by every writer: assigning one is refused for every
  caller, OWNER included, and promoting a member who carries one (members page,
  ownership transfer, invite) is refused until it is removed — 409,
  `BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`. Clearing a legacy one from an
  OWNER needs `admin.owner_management` (403,
  `CLEARING_OWNER_CUSTOM_ROLE_IS_OWNER_TIER`). The DB backstop is the CHECK
  `TenantMembership_built_in_scope_role_no_custom_role`, added `NOT VALID` and
  validated only on a clean table: while an offending row exists it stays NOT
  VALID, and that row refuses EVERY update except the clear. Its twin, for the
  same reason one layer down, is the CHECK
  `TenantCustomRole_base_role_not_built_in_scope` (#3734): a custom role is
  never BUILT on OWNER or AI_ADMIN either, because a carrier resolves to the
  role's base. Same NOT VALID shape; `deleteCustomRole` moves a legacy row's
  base to READER in the soft-delete write, or the deletion would fail it.
- **An access-review campaign does no OWNER-tier work** (#3727). Closing one
  writes its decisions under `access_reviews.close`, which an ADMIN holds, so it
  holds the members page's rules itself: a MODIFY never sets OWNER
  (`CAMPAIGN_MODIFY_ROLES`; `CAMPAIGN_NEVER_PROMOTES_TO_OWNER`) and never a
  custom role (`CAMPAIGN_MODIFY_SETS_NO_CUSTOM_ROLE`) — refused at the schema and
  again at close — and a REVOKE or MODIFY of a LIVE OWNER needs a closer holding
  `admin.owner_management` (`OWNER_SUBJECT_NEEDS_OWNER_CLOSER`), as does a REVOKE
  or MODIFY of a LIVE AI_ADMIN (`AI_ADMIN_SUBJECT_NEEDS_OWNER_CLOSER`, matching
  the members page, where only an OWNER moves one out of the role or deactivates
  it); the last-OWNER guard still applies to that closer. Each refusal is the
  WHOLE close, before any row executes, so a decision stored before the rule is
  never applied and never dropped; each writes `ACCESS_REVIEW_DECISION_REFUSED` /
  `_CLOSE_REFUSED`.
  Reasons live in `src/lib/access-review/member-decision-rules.ts`.

### Observability

All structured logging, tracing, and metrics flow through `src/lib/observability/index.ts` (barrel export). Use `log(level, message, fields)` or `logger.info(...)` for logging — the request context is read from AsyncLocalStorage inside `log`, never passed as an argument. Use `traceUsecase()` / `traceOperation()` for OpenTelemetry spans. Never `console.log` in application code.

### Auth

NextAuth v4.24.15 (stable, exact-pinned in `package.json`) is configured in `src/auth.ts`. Providers: Google OAuth, Microsoft Entra ID (via the v4 `azure-ad` provider — same OAuth endpoints, Microsoft renamed the product), enterprise SSO — SAML and OIDC (via `src/app/api/auth/sso/saml/` and `src/app/api/auth/sso/oidc/`), and Credentials. The JWT carries `tenantId`, `role`, `mfaPending`, `memberships[]`, and the Epic C.3 `userSessionId`. Token refresh logic lives in `src/lib/auth/refresh.ts`.

**MFA is asked of every workspace a session can reach** (`src/lib/auth/workspace-mfa.ts`).
`mfaPending` is the PRIMARY workspace's flag (the oldest membership): it holds the whole
session at that workspace's challenge. Every OTHER workspace whose policy wants a code
goes in `mfaPendingTenantIds`. The edge holds that workspace's paths, and org paths,
until its own challenge is passed (`pendingMfaWorkspaceSlug` in `src/lib/auth/guard.ts`).
The challenge verifies the code against the workspace in its URL, so a pending primary is
sent to the primary's own challenge page. Sign-in used to ask only the primary, so a
workspace that required MFA but was joined later let its members in on a password alone.
Do not narrow it back to the primary.

**SSO sign-in goes through NextAuth, and its session reaches one workspace.**
The SAML and OIDC callbacks do not mint a session. They verify the identity
provider's answer and issue a single-use, 60-second hand-off
(`src/lib/auth/sso-handoff.ts`), stored hashed in `VerificationToken` and
delivered in an HttpOnly cookie scoped to `/api/auth/callback/sso-handoff`.
`/login/sso-complete` then signs in with the `sso-handoff` Credentials
provider, which redeems the cookie, so the session is NextAuth's own: same
cookie, claims, workspace MFA policy and `UserSession` row as every other
sign-in. Before 2026-10-24 the callbacks hand-signed an `authjs.session-token`
that NextAuth v4 never reads, so no SSO sign-in ever produced a session. The
session is SCOPED (`ssoTenantId`, `src/lib/auth/sso-session.ts`): a tenant's
identity provider is configured by that tenant's admin and can assert any
email, so its session carries only that tenant's membership and no org
memberships, and `getTenantCtx` / `getLegacyCtx` / `getTenantServerContext` /
`getOrgCtx` / `getOrgServerContext` refuse anything else. The hand-off links
no account and redeems no invite. Do not widen the scope to "every tenant the
account belongs to": that is the cross-tenant takeover the scope exists to stop.
The round trip is BOUND to the browser that started it (`src/lib/auth/sso-flow.ts`):
`/start` seals the flow, PKCE verifier included, into an HMAC-signed HttpOnly
cookie and sends the IdP only a random id as OIDC `state` / SAML `RelayState`,
and the callback refuses without that cookie. `/start` also refuses a
cross-site initiation (`Sec-Fetch-Site`). Never put flow contents back in the
URL: that is login CSRF, and a verifier beside its code is no PKCE. The
sign-in page starts SSO by WORKSPACE (`/api/auth/sso/discover`, `SsoSignIn`),
never by email domain: `emailDomains` are unverified, so domain discovery would
let any workspace claim anyone's domain. `/login?sso=<slug>` is the shareable link.
"Enforce SSO" (`src/lib/auth/sso-enforcement.ts`): an enforcing workspace is
reachable only by its own SSO or a break-glass OWNER/ADMIN signed in with their
password — Google, Microsoft and other passwords are refused there, in the claims
and at the DB-backed gates; a sign-in left with no workspace is refused with
`sso_required:<slug>`. The session's `signInMethod` is what break-glass reads.

**The OIDC ID token is VERIFIED, not decoded** (`verifyIdToken` in
`src/lib/security/oidc-client.ts`, via `jose`): signature by a key at the
IdP's `jwks_uri`, an asymmetric-only `algorithms` allowlist, `iss` exactly the
discovery document's issuer, `aud`/`azp` naming the client, `exp`/`iat`, and
the flow's nonce. Do not add an unverified claims decoder back for
convenience; the callback used one until 2026-10-24, and any token with any
signature signed in whoever it named. The exact issuer match is also what
refuses Microsoft's `common`/`organizations` endpoints, whose `{tenantid}`
template no real token matches. Every request the client makes goes through `safeFetch`:
discovery, the token exchange, and the key set, which is handed to `jose` as
its `[customFetch]`. Only the issuer is typed by an administrator; the other
two URLs come from the IdP's own discovery document, so guarding the issuer
alone guards nothing (`tests/guards/ssrf-egress-coverage.test.ts`).

**A SAML response must answer this flow's request** (`buildSamlInstance` /
`validateSamlResponse` in `src/lib/security/saml-client.ts`). `/start` picks
the AuthnRequest ID and seals it into the flow. The callback requires
`InResponseTo` to match it (`validateInResponseTo: 'always'`, through a cache
that knows only that ID), a bearer confirmation whose `Recipient` is this
callback with a live `NotOnOrAfter`, and an assertion no older than
`SAML_MAX_ASSERTION_AGE_MS`. The flow is also spent on the server
(`src/lib/auth/sso-flow-spend.ts`), because a cleared cookie binds nothing. Do
not drop back to node-saml's default `never`: under it a captured response
signed its subject in from any browser.

**Bounded JWT membership payload.** The JWT is a fixed-size cookie credential — `memberships[]` / `orgMemberships[]` are capped at `MAX_JWT_MEMBERSHIPS` (50) in the `jwt` callback. Over the cap, `membershipsTruncated` / `orgMembershipsTruncated` is set and the middleware's `checkTenantAccess` / `checkOrgAccess` defers a slug-miss to the authoritative DB-backed server gate (`TenantLayout` / `getTenantCtx`) instead of denying. UI that needs the COMPLETE list (the `/tenants` picker) does its own server-side DB lookup — the JWT list is a bounded fast-path, not the source of truth. Old sessions (pre-cap, no flag) degrade gracefully: an absent flag reads as `false`, so they behave exactly as before until natural re-mint. Locked by `tests/guardrails/jwt-membership-bound.test.ts`.

**SSO trust is Owner-tier.** Creating an OIDC or SAML `TenantIdentityProvider`, or changing one of its trust fields, needs `admin.owner_management`: 403, reason `SSO_TRUST_IS_OWNER_TIER`, naming the changed `fields`. The trust fields are `SSO_TRUST_CONFIG_KEYS` (OIDC issuer, clientId, discoveryUrl; SAML entityId, ssoUrl, certificate) plus `type`, `emailDomains` and the JIT settings. A sign-in through the provider becomes a session for whichever member the identity provider names, matched by email on first sign-in, so an ADMIN who could re-point it could sign in as an OWNER. A trust change removes every `UserIdentityLink` to the provider in the same transaction (`SsoConfigRepository.updateAndRemoveLinks`). The rest of the form, enable, enforce and delete stay ADMIN. The diff is `changedSsoTrustFields` in `src/lib/auth/sso-trust-fields.ts`; a key belongs there only if it decides whom the provider believes. A save that leaves out the JIT settings keeps the stored ones. The Entra (`ENTRA_ID`) provider has its own writer, `usecases/entra-provider.ts`, with the same rule over `ENTRA_TRUST_CONFIG_KEYS` (`aadTenantId`, `clientId`): creating it or changing either is Owner-tier. That is not decoration, because `syncEntraMembershipRole` applies the group mappings and the gate only to a sign-in whose token `tid` equals `aadTenantId` (outcome `foreign_directory` otherwise; refused when the gate is on; no configured directory applies nothing). The SCIM Groups path passes no `signInDirectoryId` and is unaffected.

**GAP-04 — type augmentation pattern.** `src/auth.ts` declares two module augmentations: `next-auth` for `Session.user` (id/tenantId/role/mfaPending/memberships) and `next-auth/jwt` for the full JWT shape (every custom field the codebase stores). Middleware reads typed `token.role` / `token.memberships` directly via `getToken({ req, secret })`. There are zero `as any` casts in the auth-critical path; the structural guardrail at `tests/guardrails/auth-stack-pinning.test.ts` fails CI if any are reintroduced.

**Compat shims.** `auth()` returns `Session | null` (alias for `getServerSession(authOptions)`) and `signOut({ redirectTo })` redirects to `/api/auth/signout?callbackUrl=…`. Both keep the 15+ server-component import sites stable across the v5→v4 migration. New code should import `getServerSession(authOptions)` directly to make the dependency explicit at each call site.

### Environment Validation

`src/env.ts` uses `@t3-oss/env-nextjs` for type-safe env vars. Tests set `SKIP_ENV_VALIDATION=1` to bypass this. Never add raw `process.env` access — add the var to `env.ts` first.

### Background Jobs (BullMQ)

Job definitions are in `src/app-layer/jobs/`. The executor registry is `src/app-layer/jobs/executor-registry.ts`. Jobs wrap their body in `runJob()` from `@/lib/observability/job-runner`, which opens a fresh AsyncLocalStorage request context (`route: job:<name>`) and a `traceOperation` span; the BullMQ worker additionally runs each execution inside an `execute <jobName>` span linked to the originating `enqueue` span. No job uses `traceUsecase`.

### Data Retention

**See `docs/data-retention.md`** — the policy document that categorizes all 203
Prisma models into 7 retention categories (Business record / Regulatory artefact /
Operational / Security ephemeral / PII subject / Financial / Configuration),
declares the *current* retention behaviour per entity, and surfaces the open
legal/compliance/finance questions that block a formal retention commitment. It
is the lifecycle companion to `docs/encryption-data-protection.md` (at-rest
confidentiality). Today only **Evidence** has an end-to-end retention flow
(`retentionUntil` → reminders → archive → 365-day hard purge); soft-deletes on the 13
`SOFT_DELETE_MODELS` (`src/lib/soft-delete.ts`) are purged after 90 days by the `data-lifecycle` job;
`AuditLog`/`OrgAuditLog` are immutable + hash-chained and never deleted by default.
The tenant purge (`usecases/tenant-purge.ts`, the last step of `data-lifecycle`, 90
days after a tenant's soft-delete) deletes every tenant-scoped table except
`TENANT_PURGE_RETAINED`: each tenant-scoped Regulatory artefact plus the `Tenant`
tombstone. **Skipping a table does not keep a row that `ON DELETE CASCADE`s from a
purged parent** — Postgres deletes it with the parent. So a model is either
retained with everything it cascades from, or classed with its parent and purged
with it. Both owner decisions of 2026-10-18 (#3716, open question 10): access-review
campaigns are retained WHOLE, root included (`AccessReview` and every decision /
pack / narrowing / sample table), and `AgentPolicyCardVersion`,
`AgentProposalApproval`, `AgentProposalSampleAudit`, `AgenticEvidenceArtefact` and
`IncidentEvidence` left the retained set and are removed with their parent. A
retained model's FK to a purged table must be a column-scoped `SET NULL`;
`tests/guardrails/tenant-purge-retained-never-cascades.test.ts` derives the
cascade closure from the schema, with no allowlist.
Adding a new model ⇒ classify it in the doc's inventory table (the
`tests/guardrails/retention-policy-coverage.test.ts` ratchet fails CI until you do).

### Change Management

**See `docs/change-management-policy.md`** — the written contract over the
existing rapid-release pipeline (semantic-release auto-versions main on each push
that leaves the merge queue empty, plus a daily run, so its commit does not
invalidate queue candidates in flight; staging auto-deploys; production is gated
by a GitHub Environment approval).
It defines the three change classes (STANDARD / SIGNIFICANT / EMERGENCY), the
approval matrix (who is the required second approver for migrations, infra, secret
rotations, SSO/SCIM changes), the emergency-bypass + retrospective procedure, the
rollback policy (app = redeploy prior image; migrations = forward-fix, never
revert), and the audit trail (PR + CI + Environment approval + CHANGELOG). It is
the policy twin of `docs/deployment.md` (operational) and cross-links
`docs/incident-response.md` (on-call rotation). A SIGNIFICANT change — a schema
migration, a security-middleware change, a dependency major bump — must carry a
rollback plan + a risk assessment in the PR, and (for human-authored PRs) a
second engineer's `Sign-off:`. For assistant-driven PRs the owner waived the
wait for that countersignature on 2026-08-18 — see the working agreements above
and the "Owner waiver" bullet in the policy doc; the analysis is still required.

### Billing & entitlements (GAP-18)

The codebase has two billing modes, decided by a single env var:

  • `STRIPE_SECRET_KEY` set → **SaaS mode**. Per-tenant plan
    (`FREE` / `TRIAL` / `PRO` / `ENTERPRISE`) is read from
    `BillingAccount.plan` and enforced at the mutation boundary
    via `assertWithinLimit(ctx, resource)` from
    `src/lib/billing/entitlements.ts`. SaaS tenants without a
    `BillingAccount` row resolve to `FREE`.

  • `STRIPE_SECRET_KEY` unset/empty → **self-hosted mode**.
    Every tenant resolves to `ENTERPRISE` and per-resource limits
    are unlimited. No DB query happens for plan resolution.

The decision is read once at module load. Today only `control`
creation is gated (FREE: 10, TRIAL/PRO: 100, ENTERPRISE: unlimited).
Adding a new gated resource is a one-line change in `PLAN_LIMITS`,
a `switch` arm in `getCurrentCount`, and one
`await assertWithinLimit(ctx, '<resource>')` call at the create-site.

**See `docs/billing.md`** for the full operator + developer runbook,
the reasoning behind plan limits, the failure-shape contract
(`forbidden('plan_limit_exceeded: …')` → 403), and the "what NOT to
do" list (no UI-only gating, no second mode-detection mechanism, no
duplicating the limits table).

### Identity lifecycle — JML (joiner / leaver)

The subsystem that can **disable accounts in a customer's own directory — and
create them**. It is the highest-blast-radius capability in the product, and it
is deliberately throttled, but no longer by either clamp: both sit at
`AUTOMATIC` (leaver 2026-08-30 #2187, joiner #2954), so neither refuses any rung
the ladder can reach and the ladder alone governs how far a tenant may go.

**The joiner is implemented, and its write path is reachable through the
product.** `DIRECTION_IMPLEMENTED.joiner` is TRUE since #2949. This section
asserted the opposite for a long time, and every reason it gave has since been
built: the create verb (#2923), the collision probe (#2928), the Entra
provisioner (#2940), the entitlement map's schema and reader (#2713) and its
writer (#2839), the operator surface (#2944). `LIVE_PROVISIONER_PROVIDERS` is
`['active-directory', 'entra-id']` — both, not AD alone.

What holds a joiner create today is **the per-connection grant, not the clamp**,
and the two providers are deliberately asymmetric:

| provider | grant field | on the connection form? | effect today |
| --- | --- | --- | --- |
| Entra | `joinerWritesEnabled` | **yes**, off by default | an owner can reach a live create through the product |
| Active Directory | `joinerWritesEnabled` | **no**, undeclared on purpose | refuses for every connection — read strict `=== true`, so an absent value fails closed |

Acting needs BOTH grants, not just the joiner's: `executePlannedCreates`
resolves a provisioner *and* a writer, and refuses rather than create an account
it could not undo. So the whole path to a real account creation is — tick the
Entra grant, grant offboarding writes (`writesEnabled`), have an administrator
consent `User.ReadWrite.All` + `Policy.Read.All`, and walk the ladder DISABLED
→ DRY_RUN → (seven days) → AUTOMATIC. Every step is a deliberate act; none of
them is a clamp.

**There is no mover, and the M in JML has never stood for anything here.** This
header carried the industry's three-letter expansion until #2487, and it was the
only place in the repo the word appeared AS A PRODUCT DIRECTION — which is
exactly how a word becomes a roadmap item nobody wrote. (The qualifier is load-
bearing: "top movers" appears in two risk-trend implementation notes, in an
unrelated sense.) `IdentityDirection` in
`src/lib/identity/write-ladder.ts` is a closed `'leaver' | 'joiner'` union,
`DIRECTION_IMPLEMENTED` has those two keys, and `TenantSecuritySettings` carries
those two columns (`identityLeaverMode`, `identityJoinerMode`). So a mover is not
an unimplemented direction — it is an unrepresentable one, with no rung to set,
no column to set it in and no value to name it by. Adding one is a schema change
and a migration before it is a feature. The distinction matters when reading the
joiner: the joiner is a direction that EXISTS, is implemented, and is switched
off BY DEFAULT — which is a different kind of nothing.

**The chain is four scheduled jobs, and the order is load-bearing.**

```
03:00 UTC  identity-sync-dispatch    per enabled okta / google-workspace / entra-id / active-directory connection
04:00 UTC  hris-sync-dispatch        per enabled bamboohr / workday connection  (roster → Employee)
04:30 UTC  identity-joiner-dispatch  per (tenant, provider) over WRITABLE_IDENTITY_PROVIDERS  (#2687)
05:00 UTC  identity-leaver-dispatch  per (tenant, provider) over WRITABLE_IDENTITY_PROVIDERS
```

Both passes act only on evidence a **complete** sync re-observed, so 04:30 and
05:00 sit after 03:00 on purpose. The two JML halves are also given separate
minutes on purpose — they read the same tables and write to the same execution
log, so an incident in one must not arrive inside the other's window and be
triaged as part of it — and 04:30 is off the hour because 04:00 already carries
`retention-sweep`. `schedules.ts` states each of those reasons at the entry
itself. **Declaration order in `SCHEDULED_JOBS` is NOT execution order** — only
the cron pattern is; reading `schedules.ts` top-to-bottom gives the wrong
sequence.

**Each table has exactly one write seam. Do not add a second.**

| Table | Written by |
| --- | --- |
| `ConnectedIdentityAccount` | `identity-sync.ts` (upsert + the deprovision `updateMany`) and `identity-account-protection.ts` (the never-offboard flag) — nothing else |
| `IdentityAccountLink` | `identity-account-link.ts::reconcileIdentityAccountLinks`, whose ONLY caller is `reconcileLinksAfterSync` inside `runIdentitySyncJob` |
| `Employee` | `personnel.ts::createEmployee` (MANUAL), `personnel.ts::setEmployeeManager` (the `managerEmployeeId` COLUMN only, #2492) and `hris-sync.ts` (HRIS). There is still **no update path** for an employee's status outside HRIS sync — the manager path cannot reach that column, and `tests/guards/employee-status-single-write-seam.test.ts` fails if it ever does, or if a third file starts writing an `Employee` row at all |

**The link reconcile lives in the JOB, not the usecase.** `runIdentitySync` (which
the manual "Sync now" route calls) enumerates the directory; `runIdentitySyncJob`
enumerates *and then* reconciles links. So a manual sync fills the roster and
creates no links, and the next pass refuses `NO_FRESH_LINKS`. Any new caller that
needs links must go through the job, or the seam moves.

Reconcile is gated on the sync returning `PASSED` — a `PARTIAL` (resumable) or
`ERROR` (truncated at the 5000-account cap) sync creates no links. Matching is
**exact normalised email** between `Employee.workEmail` and
`ConnectedIdentityAccount.email`, and only when exactly one employee holds that
address. For Entra that address is `u.mail || u.userPrincipalName`.

**The write-mode ladder** (`DISABLED → DRY_RUN → AUTOMATIC`) is stored
per direction on `TenantSecuritySettings.identity{Leaver,Joiner}Mode`, defaulting
to `DISABLED`. `setIdentityWriteMode` in `usecases/identity-write-policy.ts`
refuses multi-rung widening, refuses to leave `DRY_RUN` before
`DRY_RUN_MIN_DAYS` (7), and refuses ANY widen of a direction whose
`DIRECTION_IMPLEMENTED` flag is false — which is now NO direction, both being
true, so that refusal is unreachable and kept as the brake. Any move out of
`DRY_RUN` — including narrowing — nulls `dryRunSince` and restarts the clock.

**There was a fourth rung, `PROPOSE`, and deleting it CLOSED a hole rather than
opening one** (2026-09-02, #2241). It sat between `DRY_RUN` and `AUTOMATIC` and
meant "a human approves each disable" — a queue that was never built, so
`identity-disable-account` refused every candidate at that rung: the rung above
yielded strictly less than the rung below. The harm was in the composition. The
seven-day dwell fires on `current.mode === 'DRY_RUN'` only, so it gated
`DRY_RUN → PROPOSE` and nothing gated `PROPOSE → AUTOMATIC`; combined with the
widen-one-rung rule, the compulsory rung was also the only ungated one. The real
price of unattended directory writes was seven days and two PUTs that could
follow each other by a second. With the rung gone, `DRY_RUN → AUTOMATIC` is one
move and the dwell that already existed now stands in front of it. **No new gate
was added — the detour around the old one was removed.**

Two consequences worth knowing before touching this:

- **The DB enum still carries `PROPOSE`, on purpose, and no migration was
  written.** Postgres cannot drop an enum value without recreating the type, and
  an `ALTER TYPE` mid-rolling-deploy makes still-running old containers fail with
  SQLSTATE 42704 — the same lesson the `@@map("WorkItem*")` pins record. So the
  value outlives the rung.
- **A stored `PROPOSE` is therefore an UNKNOWN mode, and unknown fails
  PERMISSIVE.** `isAboveClamp` sorts it to -1, i.e. *not* above the clamp, i.e.
  cleared to run, and it is not the literal `'DRY_RUN'` the writer factory used
  to look for either. `coerceStoredMode` in `write-ladder.ts` translates it (to
  `DRY_RUN`; anything else unrecognised, and absence, to `DISABLED`) and is
  applied at the READ boundary in `getIdentityWritePolicy` — before any
  comparison, clamp check or dwell arithmetic anywhere. Two backstops sit behind
  it, both written as allowlists: the writer factory builds a live writer only at
  `AUTOMATIC`, and the disable usecase writes only at `AUTOMATIC`. If you add a
  rung, it inherits nothing by falling through.

`LEAVER_MAX_MODE` is a **source constant, not config**, enforced at gate 1 of
`runIdentityLeaverPass`. It was `DRY_RUN` until 2026-08-30 and is now
`AUTOMATIC` (#2187), so no rung the ladder can reach is refused by the clamp.
`JOINER_MAX_MODE` in `identity-joiner-pass.ts` is its twin and sits at
`AUTOMATIC` too (#2954), so the same holds for the joiner: with the clamp on
`LADDER`'s last rung `isAboveClamp` can never be true and `MODE_ABOVE_CLAMP` is
unreachable for either direction. Each constant's remaining job is to be the
brake — narrowing it is a reviewed diff somebody can ship in a hurry, which is
why the branch it feeds is kept rather than deleted for being inert.
What still governs is the ladder: DISABLED by default, one rung per widen, and
`DRY_RUN_MIN_DAYS` before leaving dry run.

**The gate is ORDINAL, and that is load-bearing.** It was `mode !== LEAVER_MAX_MODE`,
which is correct only while the clamp sits at the second rung — at `AUTOMATIC` a
tenant at `DRY_RUN` is not equal but is BELOW, and the inequality would have
refused it `MODE_ABOVE_CLAMP`, a refusal that records no row. The ladder order
now lives in one place, `src/lib/identity/write-ladder.ts`, used by the pass, the
policy usecase, the admin route's GET and the admin client; it carries no server
imports so a client component can hold it. (The route's `GET` held a fourth
verbatim copy until #2241 — the module's own docstring named the copies it
replaced and missed that one, which is how a route can go on offering a rung the
ladder no longer has. Its `PUT` body schema is now `z.enum(LADDER)`, so a PUT
naming a retired rung is a 400 rather than a silently coerced write.)

The admin route reports the clamp to the UI in a `honoured` block. Lowering the
clamp again must be a diff somebody reviews.

**Both ladder refusals are the only ones that write no `IntegrationExecution`
row** — they emit a metric and a log line, but nothing lands on
`/admin/identity-leaver-passes`. Every other refusal records a
`NOT_APPLICABLE` row naming its reason. This asymmetry is why a tenant left at
`DISABLED` looks identical, from inside the product, to a dead worker.

**In `DRY_RUN` no directory writer is constructed.** `resolveDirectoryWriter`
returns the snapshot arm before either live writer (Entra / Active Directory) —
but BELOW the `NO_CONNECTION` and `AMBIGUOUS_CONNECTION` refusals, so a dry run
still needs exactly one enabled connection to get a snapshot at all, so a dry run needs neither
`writesEnabled` nor `User.EnableDisableAccount.All` and opens no socket. It does
still decrypt the connection secret (for self-account ids) and degrades to
config-only with a WARN if that fails.

`beginWrite` on the write journal sits *below* the mode allowlist, so it is
reached only at `AUTOMATIC`. **On 2026-09-12 at 05:00 UTC it was reached for
real.** One live Entra account was disabled, confirmed in the customer's portal;
`IdentityWriteJournal` took its first row ever, `APPLIED`; and
`checkDisableBlastRadius` ran against a real batch for the first time.

**That inverts the advice this paragraph used to give.** It said "do not treat
journal rows as evidence a pass ran", which was correct only while the table was
empty — a row could then only have come from a test or a hand-written insert. A
row is now the *strongest* evidence the subsystem produces, because of where
`beginWrite` sits: reaching it means the tenant was at `AUTOMATIC`, the ladder
and the clamp both cleared, a complete sync had left fresh links, a live writer
was constructed, the blast-radius breaker passed the batch, and a call to the
customer's directory was about to be made.

**Hold onto the asymmetry, which is the half that did not change: a row proves a
write was attempted, and no rows prove nothing whatsoever.** Every tenant at
`DISABLED` or `DRY_RUN` leaves the journal empty by design, and so does every
refusal that stops the pass above `beginWrite` — which is most of them. Two of
those, the ladder refusals, leave no `IntegrationExecution` row either, so they
are invisible on both surfaces at once. "Did a pass run?" is answered by
`/admin/identity-leaver-passes`; "what did it change?" is answered by the
journal. Reading the second for the first is how an empty page gets mistaken for
a quiet night.

The journal has a read surface as of #2490: `admin/identity-write-journal`, an
index plus a per-row detail route that resolves the `journal reference <id>`
that the DISABLED notification quotes. Both are gated `admin.tenant_lifecycle` —
OWNER-only; ADMIN deliberately does not hold it, because a row names a change
made to one of a customer's people's accounts. Both are read-only, and that is a
decision rather than an unfinished half: `DirectoryWriter` declares no `enable()`
verb, so re-applying a captured prior state is an act somebody performs in the
customer's own directory, holding the state this surface hands them.

**Refusal order matters when reading an outcome.** `ALREADY_DISABLED` is checked
before the write-target rail, so an account that last synced as suspended returns
silently. `onPremisesSyncEnabled` maps absent/null to `null`, and **a null alone
no longer decides the outcome** — `onPremStateObservedAt` does. Three outcomes,
all reported as one `null`:

| `onPremStateObservedAt` | basis | operator response |
| --- | --- | --- |
| absent | `NEVER_OBSERVED` | wait for the nightly sync; it clears itself |
| within 2 days | `CLOUD_ONLY_OBSERVED` | **allowed** — the directory answered |
| older than 2 days | `OBSERVATION_STALE` | waiting will NOT clear it: re-enable the soft-disabled connection that observed these accounts |

The middle row is what makes the leaver path reachable at all for a cloud-only
Entra tenant; before it, every such candidate refused and the path was
permanently inert without AD Connect. The migration deliberately did not
backfill, so every pre-existing row refuses `NEVER_OBSERVED` until its next sync
stamps it — that window is the rail working, not a broken sync.

**New HRIS behaviour is PROVEN against OrangeHRM, not BambooHR** (2026-09-18). Not a
preference — BambooHR is customer-owned, this repo has no tenant, and open question 1 of
the write-back design ("does BambooHR expose an employee-update API?") is *unanswerable
from here* rather than merely unanswered. OrangeHRM is self-hostable and writable, which
is what #2548 built it for and what #2587 demonstrated: running the finished connector
against a live 5.9 disproved its field mapping in five places that fifty green tests had
not noticed. So when new HRIS behaviour must be shown to WORK rather than to typecheck,
point it at the OrangeHRM instance and record what came back. This is a rule about
evidence, not about tests: BambooHR keeps every test it has, and the structural guards
that enumerate providers must keep naming `bamboohr`. See the "New HRIS work is proven
against OrangeHRM" section of `docs/jml-hris-write-back-design.md` for what this does and
does not license — in particular it does NOT answer open question 1, because a different
vendor's API is not evidence about this one.

**Adding to this subsystem:** a new writable provider goes in
`WRITABLE_IDENTITY_PROVIDERS` and needs a writer plus its own branch in
`resolveDirectoryWriter`'s construction block — the last arm there falls through
to `createActiveDirectoryWriter`, so a provider added without a branch silently
gets an AD writer; a new directory provider that only reads goes in
`IDENTITY_PROVIDERS` in `jobs/identity-sync.ts` (and the two other copies of that
list — they are not shared). Follow
[docs/new-subsystem-checklist.md](docs/new-subsystem-checklist.md) as usual.

When the chain produces nothing, the causes are numerous and all present
identically as an empty page — use the `identity-chain-diagnostic` skill rather
than guessing.

### Legacy access recertification

Reading legacy applications' access tables through operator-hosted MCP servers and
reconciling them against HR. Design and plan:
`docs/legacy-access-recertification-design.md` and
`docs/legacy-access-recertification-phases.md` — **those two documents are the source
of truth for intent.** If the code contradicts a fact in them, the code wins and the
pull request says so; if a step would have to deviate from the design, stop and ask.

Five invariants bind everything in this subsystem. Later steps extend this section;
none of these move. The first four were seated by Step 0a; the fifth was earned by
Step 5a, which found the same defect four times in one flow.

1. **Legacy code never writes a directory table.** `IdentityAccountLink` and
   `ConnectedIdentityAccount` are read-only to it.
   `tests/guards/directory-identity-tables-single-write-seam.test.ts` enforces it
   across three paths — a delegate call on any client, the same call on a transaction
   client, and raw SQL — with the seams listed in that file and nowhere else. A row
   written by a matcher that guessed would not look wrong; it would look like a sync
   had found it.
2. **Only a strong deterministic signal produces `LINKED`.** A confirmed alias, a real
   employee number, an exact email, or the directory bridge. Similarity, a naming
   convention, a model verdict and a bulk action may reach `SUGGESTED` and no further:
   a person confirms every link.
3. **Legacy data is untrusted input.** Size-bounded, schema-validated, rendered only as
   text, never logged row by row, and it reaches a model only through the AI Guard.
4. **Fail closed, and never silently.** A truncated, torn, drifted, partial or
   unauthenticated read is recorded with a named reason and never reported as complete.
   A row that cannot be keyed fails the pull rather than being dropped — an account
   missing from a snapshot is an account nobody reviews.

5. **Zero is never complete.** A review over no subjects evidences nothing, and every
   natural way to write the completeness check says the opposite. `pending.length === 0`
   and `decided === total` are both TRUE of the empty set, so a campaign with no
   subjects closes instantly, reports success, and produces an artefact attesting that
   every account in scope was reviewed — vacuously true of its rows and false of the
   directory, which is the only reading an auditor cares about. Step 5a found this
   four times over in one flow: the close usecase, the Close button's `disabled`,
   a `subjectRef` collision that silently dropped a subject through
   `skipDuplicates`, and a `take: N` that cannot tell "N accounts" from "the first N
   of more". So: refuse an empty population at CREATION, refuse it again at
   COMPLETION, and read one past any cap so truncation is a fact you hold rather than
   one you cannot observe. Any count that gates a claim about a population must assert
   the population is non-empty in the same expression — `subjectCount > 0 && decided
   === subjectCount`, never `decided === subjectCount`.

**How invariant 2 is enforced, since Step 3b** (`src/lib/identity/reconcile/engine.ts`).
Strength is not a number and not a claim a signal makes about itself. `SIGNAL_STRENGTH`
is a frozen table keyed on a closed union, so a kind added without a classification is a
compile error rather than an `undefined` that `=== 'STRONG'` quietly reports as false.
There are exactly four strong kinds — `CONFIRMED_ALIAS`, `EMPLOYEE_NUMBER`,
`EMAIL_EXACT`, `DIRECTORY_BRIDGE` — and `LINKED` requires one of them held by exactly
one candidate, unvetoed.

**The Step 4a extension point cannot break it, by type.** `CandidateScorer` returns
`SupportingSignal`, whose `kind` is narrowed to the non-strong union. Naming conventions
and similarity therefore cannot produce a `LINKED` however they score — not by
convention, by `tsc`. Do not widen that return type to `Signal`; the exhaustive test
over all 127 non-empty subsets of the supporting kinds (at score 10,000 each) is what
proves the property, and it is only meaningful while the type prevents the strong case.

Three further rules the engine holds that are easy to undo:

- **`EMAIL_EXACT` is `emailKey` byte-equality, never a folded domain.** `+tag` removal
  and domain equivalence are a SUPPORTING signal one layer above the key. `emailKey` is
  what the JML chain joins on, so a link made on a folded address is a link the leaver
  cannot act on — the design document's `da-01` case exists to say so.
- **An employee number is derived from a login only when the login is all digits.**
  `normaliseEmployeeNumber` accepts up to eight leading letters, so `kpatel3` yields
  `3` — a name with a counter posing as the strongest signal in the system.
- **A roster carrying one id twice with different fields is REFUSED**
  (`DuplicateRosterIdError`), not resolved by arrival order. `RosterEmployee.id` is a
  primary key; a roster that contradicts itself about one person gives no reason to
  trust what it says about the others. An exactly-repeated row is tolerated — the check
  is about contradiction, not duplication.

**The decision-model path, since Step 6b** (`src/app-layer/ai/identity-match/`). Four
invariants, each enforced by a test rather than by convention:

- **`TYPESAFE_SUBPROCESSOR_ACTIVE` is `false`, and flipping it is a sub-processor
  activation.** Not a configuration change, not an environment variable — a reviewed
  diff, after the notice window in `docs/sub-processor-change-policy.md` closes. While
  it is false, `getDecisionProvider` returns the local provider instead of a Jev one for
  every mode, so a tenant setting `legacyMatchAiMode = EXTERNAL` achieves nothing. Do
  not "simplify" that branch away on the grounds that the mode check already covers it:
  the mode is tenant-settable and this is not.
- **The Jev host is a code constant.** `JEV_ENDPOINT` is a plain literal — no template,
  no `env.`, no `process.env`, asserted by reading the line. A configurable host is an
  SSRF for whoever can write that column, and it would make the sub-processor register
  describe a destination the code no longer uses. `LAYA_BASE_URL` was deployment
  configuration for the same reason, and no tenant-writable column reached it — the
  variable and the provider that read it were deleted on 2026-10-14 when the owner
  retired the Laya estate, so `buildLocalProvider` now returns the refusing stub and
  `legacyMatchAiMode = LOCAL_ONLY` is refused at the settings boundary. The rule is kept
  because it governs whatever local endpoint comes next: a tenant must never be able to
  name the host a model runs on.
- **Residency is structural.** The factory RETURNS before constructing anything
  external; it does not construct-then-skip. A constructed-but-unused external provider
  is one refactor away from a called one, and the refactor looks like tidying.
  `tests/guards/ai-residency-enforcement.test.ts` reads the source for the ordering AND
  pins the constructor set, so a fourth provider fails CI until somebody classifies it.
- **A revision with no evaluation record produces no verdicts.** Records live in
  `src/app-layer/ai/identity-match/evaluations/` and the directory is empty today. The
  gate recomputes every derived figure from the record's own raw answers — a stored
  precision figure is never trusted — and scores a model that is unsure about everything
  as 0, not 1.

Two shapes in that module that are easy to get wrong a second time:

- **`z.partialRecord`, never `z.record`, for a probability map keyed on the option
  enum.** `z.record` with an enum key is EXHAUSTIVE in Zod 4, so it demands a
  probability for all six options and rejects every valid two-candidate response.
- **The transport's deadline is the CALLER's.** Adjudication runs inline over every
  residue account, so a retry that honours `Retry-After` in isolation hands a third
  party control of the pass's schedule. A back-off that does not fit the remaining
  budget means no retry at all, and a timeout is never retried.
**The MCP client, since Step 1b** (`src/lib/mcp/client/`). Pure transport — no Prisma,
no tenant — and four rules that are each one careless edit from being undone:

- **There is exactly ONE `complete: true` in the module.** Every other path returns
  through a single `catch` that sets `complete: false` and reduces the typed error to a
  `reason`. The failure mode this guards is not an exception; it is a fault reporting
  completeness anyway, and the way it arrives is a new early return that forgets the
  flag. If you add one, it goes through the same place.
- **`safeFetch` is called in an EXPLICIT branch**, not resolved into
  `ctx.fetchImpl ?? safeFetch`. The alias form made `safeFetch(` vanish from the file, so
  `tests/guards/ssrf-egress-coverage.test.ts`'s "this sink calls safeFetch" check had
  nothing to match and was passing on the import alone. The branch also shows that
  exactly one path reaches the network unprotected, and that it is the test seam.
- **`fetchImpl` is a TEST SEAM.** No file under `src/` may pass one — a structural rule
  in `tests/unit/legacy-mcp-client.test.ts` fails if one does, and fails if the client
  directory calls `fetch` or `resilientFetch` directly. A production caller supplying one
  would route around the SSRF defence in a diff that looks like dependency injection.
- **Oversharing is STRIPPED and REPORTED here, never refused here.** An unrequested
  column is removed at the socket — so nothing downstream can store, render or log
  what it never receives — and its NAME goes into `PullResult.overshared`. Whether
  it is fatal is the CALLER's decision, because fatality depends on the
  never-request denylist, which is product policy this module does not know:
  `usecases/legacy-access-pull.ts` refuses with `OVERSHARED_DENIED_COLUMN` when a
  stripped column is denylisted and flags the connection otherwise. Do not
  "restore" the unconditional refusal this replaced (#3319): its argument was right
  — silently dropping a column hides the server owner's bug from the only person
  who can fix it — but its scope was wrong, and it meant a customer whose server
  ignores `?fields=` had their recertification stopped rather than flagged. The
  names are reported on failure paths too, because a denylisted column having
  crossed the wire is a fact about what left their network, not a claim about the
  table.
- **Bodies are read through a byte-capped stream that ABORTS at the cap.** Never
  `res.json()` or `res.text()` then a length check: both have already allocated the whole
  body by the time you could measure it, which makes the cap a report rather than a
  defence. `Content-Length` is a free early refusal, not the check — it is a claim by the
  party being defended against, and absent on a chunked response.

Two smaller ones worth not rediscovering: a `notifications/*` response legitimately
carries no content-type (a bodiless 202), so the `application/json` requirement applies
only where a body is read — but SSE is refused even there, because the contract forbids
the transport. And the client parses each advertised page URI and REBUILDS it with its
own projection rather than requesting it verbatim: a server-supplied URI is a
server-supplied request target.

**Conventions and similarity, since Step 4a** (`reconcile/conventions.ts`,
`similarity.ts`, `scorers.ts`). These are the fuzzy signals, and the rules that make
them safe to have:

- **A convention is DECLARED by a human, never inferred from the data.**
  `proposeConventions` measures how much of a snapshot each template explains and
  returns a list with no "best"; `adoptUsernameConvention` is what adopts one, and
  it is `assertCanAdmin`, versioned and audited. Fitting a template to the snapshot
  it will then match is circular, and the population being fitted contains the
  leavers this product exists to find — a learned template explains away the
  anomalies.
- **A collision is an EQUAL SCORE, not a tie-break.** `jsmith` generated for both
  John and Jane Smith emits the same signal at the same score to each, and the
  engine's existing tie rule yields `AMBIGUOUS`. Do not "improve" this by having
  the scorer prefer the earlier hire or the lower id: that is the scorer inventing a
  rule the convention does not contain, and it reaches a reviewer as confidence.
- **A name that cannot be split generates NOTHING.** `fullName` splits only at
  exactly two tokens — a mononym and a three-part name both generate no candidate.
  Guessing turns "Maria del Carmen Garcia" into `mdel`.
- **`CandidateBlocker` may only ADD candidates**, and every id it returns is counted
  in `metrics.comparisons` so the stated budget still binds. A blocker that removed
  candidates could make a STRONG signal unreachable because an extension did not
  recognise an account; a blocker that scanned the roster would undo the blocking
  index from outside it.

Two numbers in there are pinned and should not be casually moved: the Jaro-Winkler
implementation is in-house so the published reference values (`MARTHA`/`MARHTA`
0.961, `DWAYNE`/`DUANE` 0.84, `DIXON`/`DICKSONX` 0.813) can be asserted, and
`SCORER_WEIGHTS.SIMILARITY_FLOOR` decides what a human is asked to look at — a
mutation found it untested, so it now has its own assertions.

**The `legacy-mcp` provider, since Step 1c.** Two rules, and the second is the one
that nearly went wrong:

- **`publicOrigin` is the rule kind for a host we cannot enumerate.** Not
  `vendorOrigin` (no allowlist can name a customer's own host) and not
  `internalOrigin` (that settles only the scheme, which is right for an `ldaps:`
  bind inside a customer network and wrong for dialling out to whatever was typed).
  It requires https and runs `checkWebhookUrl` at save time; `safeFetch`
  re-resolves at use time, which is the half that closes DNS rebinding.
- **Any new origin rule kind MUST go in `ORIGIN_KINDS`.** That `Set` is the whole
  population of `originFieldsFor`, which is the whole population of
  `redirectsStoredCredential`. A host-bearing field outside it can be repointed at
  an attacker's host while keeping the stored credential. `originFieldsFor` used to
  filter on two kinds spelled out inline beneath a docstring promising a third
  would be covered automatically — it would not have been, and adding
  `publicOrigin` is what proved it.

Also: **a green Test button on this provider does not mean the pages are
readable.** `probeManifest` handshakes and reads the manifest and stops, so it
cannot see the torn-snapshot failure, which only appears while paging. And
`validateConnection` must never call `markAuthFailure` — that flag is read by the
freshness surface and the leaver pass, so a half-typed token in the Test box would
otherwise be recorded as the integration being down.

**Snapshots and the fail-closed pull, since Step 2a** (`src/lib/legacy-access/`,
`usecases/legacy-access-pull.ts`). Seven refusals, and the shape of each is the
lesson: a pull that cannot vouch for its population says so rather than
degrading.

- **The payload hash is ordered by `accountKey` ITSELF, not by the serialised
  line.** Sorting the lines gives the same answer today — `accountKey` happens to
  sort first among the canonical field names — but that is an accident of the
  alphabet, and a future field named before it would silently re-order the whole
  population and change every hash. `tests/.../legacy-access-canonical` holds the
  reasoning.
- **`UNKNOWN` is treated as ABSENCE in the contradiction check, not as a value.**
  Two rows disagreeing `ACTIVE` vs `UNKNOWN` are not contradictory — one of them
  simply did not answer. Comparing it as a value broke every legitimate
  long-layout table, and the test that caught it was the step's own.
- **A denylisted column is refused; an unrequested one is STRIPPED and
  REPORTED.** The transport cannot know which columns are fatal, because fatality
  is product policy; the caller decides. See invariant 3 and `OVERSHARED_DENIED_COLUMN`.
- **A value-set is exposed only when it cannot identify anybody.** `mayExposeValueSet`
  needs a low distinct count, a minimum row count, a repetition floor AND zero
  e-mail share — four terms, because any three of them admit a column of 12
  unique names.

**Resolutions and the crosswalk, since Step 3c** (`usecases/legacy-reconcile.ts`).
A run's verdicts are immutable: a second run ADDS rows keyed on
`(executionId, accountKey)` rather than overwriting, so "why was this suggested
in March?" stays answerable.

- **Three gates, each refusing with a named reason**: the snapshot must be
  COMPLETE, the HRIS roster must be FRESH, and the directory bridge is checked
  per link rather than per run. A stale roster mass-produces false orphans and
  false leavers, which is worse than refusing.
- **A refusal records `PARTIAL`, never `ERROR`.** `ERROR` means the run broke;
  `PARTIAL` means it declined. Conflating them makes a deliberate refusal look
  like an outage on the integrations page.
- **The freshness constant is imported from `identity-write-target.ts`**, not from
  the leaver pass — importing the pass would drag the writer factory and both
  provider writers into this module's graph, and for THIS module that is the
  wrong direction even with no call site (invariant 1).

**The review queue and alias revalidation, since Step 4b** (`usecases/legacy-reviewer-actions.ts`,
`reconcile/alias-revalidation.ts`). A `LegacyIdentityAlias` is the only thing
that can make an account `LINKED` alone, because it records a decision a person
made.

- **A DEPARTURE NEVER SUSPENDS AN ALIAS.** Four triggers do — recreation, an
  account postdating employment end, a re-key, a vanished HR record — and leaving
  is not one of them. With the alias the account is reported as a leaver with live
  access; without it, it is an `UNMATCHED` row indistinguishable from an
  unclassified service account, so suspending would delete the one fact that made
  it urgent. `makeRekeyLookup` is exported from the engine so "re-keyed" has ONE
  definition; two would eventually disagree in the direction that grants access.
- **Revalidate, suspend, then resolve against the SURVIVORS.** Resolving against
  what was read and suspending afterwards records `CONFIRMED_ALIAS` on the very
  run that stopped trusting the alias.
- **A decided account leaves the queue, and the queue reads ALIASES to know
  that.** Three of the six reviewer actions produce no evidence the engine can
  use, so they resolve `UNMATCHED` for ever; a queue built from resolutions alone
  asks the reviewer the same question every cycle. A SUSPENDED alias does not
  suppress — that is the revalidation pass's own output — and an expired
  `EXTERNAL` returns LABELLED, because it did not become doubtful, it became old.
- **`confirm` is OWNER+ADMIN, and the usecase reads the GRANULAR key.** For a
  built-in role that equals `canAdmin`; for a CUSTOM role granting confirm over a
  READER base it does not, and a coarse check would refuse what `requirePermission`
  allowed.
- **Bulk is bounded by `SCORER_WEIGHTS.CONVENTION`** — the largest score any
  single supporting signal can contribute — so a row qualifies only when its
  leader is ahead by more than one whole signal, and re-weighting the scorers
  re-tunes the bound instead of leaving a constant that stops meaning anything.

**Recertification campaigns, since Step 5b** (`usecases/access-review-legacy.ts`,
`lib/legacy-access/findings.ts`). `LEGACY_APP` reuses
`AccessReviewConnectedDecision` with `subjectRef` as `connectionId:accountKey`
and `connectedAccountId` NULL — a third decision model would mean a third
implementation of reminders, closing and the evidence PDF.

- **FINDINGS ARE A SET, NOT A LABEL.** This is how invariant 5's sibling rule —
  "no other state ever suppresses a leaver with live access" — is actually held.
  A single label means something has to win, and the day a privileged dormant
  leaver arrives two of those three do.
- **Dormancy speaks only where the POPULATION reports last-login; privilege does
  the opposite.** An application that carries no `lastLoginAt` would otherwise
  mark every row dormant, and a finding on every row is a finding on none. But
  privilege is a positive claim about an entitlement, so absence is NOT evidence
  for it — a critical badge on every row of a snapshot that cannot answer is
  worse than silence.
- **A mover is measured against the last CLOSED campaign only**, and no prior
  record is a first sighting rather than a move. A value absent on either side is
  a change to the MAPPING, not to a person.
- **The subjects are FROZEN at create**, and the test proves it by pulling again
  and asserting the stored decision is byte-identical.
- **The evidence carries its provenance** — payload hash, mapping version,
  resolution method — read off the frozen subjects rather than re-queried, because
  re-reading at close reintroduces the drift the freeze removed. The hash lets an
  auditor re-derive from the stored rows through `verifySnapshotPayloadHash`.
- **SOC 2 suggests the brief's own `CC6.2` and `CC6.3`**, since #3369 completed
  CC6 to CC6.1-CC6.8. It suggested `CC6.1` as a substitute while the catalogue
  carried one sub-code per criterion and neither of the brief's codes existed;
  the test that asserted that ABSENCE is what forced the revisit, and now
  asserts presence. Six of the eight sub-codes were re-attributions of controls
  already written under `CC6.1`. See `legacy-evidence-controls.ts`.
- **A remediation task for a legacy campaign says to act IN THE APPLICATION**, and
  says we never write to it. The connected wording — "in the identity provider" —
  would invite somebody to wait for an automation that cannot exist.




### Agentic AI for IAM roadmap

Six use cases that extend IAM controls to autonomous agents, in five phases.
**`docs/agentic-iam-roadmap.md` is the source of truth for intent**, and the
step issues under #3654 are the work, one pull request each. Rules that bind
every step are listed at the end of that document.

**The harness ladder** (`src/lib/agentic/harness-ladder.ts`, H0–H5) has three
properties that are each one careless edit from being undone:

- **Unanswered counts as no.** A rung is met only when every criterion on it and
  below it is met WITH an evidence reference; a met verdict with no evidence is
  not met, and a criterion reported twice is judged on its worse answer.
- **The ladder is report-only** (owner decision, 2026-10-17). A level raises
  findings and never gates an activation or a tool call. `eslint.config.mjs`
  refuses an import of the ladder from the authority funnel's files at error
  level; do not widen the ladder's reach by moving a gate into a file that
  block does not list.
- **Order lives in one place** and comparison is ordinal (`levelAtLeast`).

**The scanner report contract** (`inflect-agent-harness/2` and `/3`,
`docs/agent-harness-contract.md`, `src/lib/agentic/harness-contract.ts`) is
verified in one order: size, JSON, signature by a TRUSTED key, then the strict
schema OF THE ID THE REPORT NAMES. `/3` (#3785) is `/2` plus the `gcp-sa`
source kind and nothing else, so a `/2` report naming `gcp-sa` is refused; the
reference scanner speaks `/3`. `/1` was retired with the scanner container
(#3686), and a report naming it is a `SCHEMA` refusal that writes nothing. A
new id is a new strict schema beside the others, never a lenient one that reads
either — and a new kind also widens the estate CHECK, and must be classified in
`IDENTITY_BEARING_SOURCE`, which will not compile until it is. The report cannot
state a level, cannot carry a credential value, and cannot declare
completeness; all three are derived or refused.
`tests/helpers/agent-harness-fake-scanner.ts` is the reference implementation,
and produces both ids. `/2`'s optional per-tool `calls`/`windowDays` are stored
with the tool in `toolsJson`; its optional `models[]` endpoints are stored in
`AgentHarnessScanItem.modelsJson` (#3759). That column has THREE states, and
`parseStoredHarnessModels` keeps them apart: NULL is NOT REPORTED (a `/1` scan,
or a `/2` agent without `models`), `[]` is reported empty, and a value that
fails the strict re-read is UNREADABLE. Write NULL as `Prisma.DbNull`, never as
`JsonNull` or `[]`.

**The harness ingest** (`usecases/agent-harness-scans.ts`, since #3665) is the
only writer of `AgentHarnessScan`, `DiscoveredAgent` and `AgentHarnessScanItem`;
the key, acceptance and estate usecases are the only writers of theirs, and
`tests/guards/agent-harness-single-write-seam.test.ts` holds all seven. Four
rules in it are easy to undo:

- **Whose reports count is the register's decision, never the scanner's.**
  Registering a key takes `admin.agent_registry`; posting a report takes
  `admin.agent_harness_ingest`, which an API key gets from the
  `admin:harness_ingest` scope. The same key, with `mcp:read`, reads the
  register through `get_harness_register` (#3686), the one MCP tool a scanner
  calls; its `resourceScope` is the only non-view scope a read tool takes, and
  the read-suite guardrail names it. Do not let the ingest key register keys: a
  scanner that could would vouch for any report it liked.
- **The report's claims are inputs, not facts.** The level is derived by the
  ladder; `registeredAgentId` links only to a row the register holds; the
  report's own `findings` member is not acted on. All of it is decided in the
  pure planner `src/lib/agentic/harness-findings.ts`, where it is unit-tested.
  With no claim the register holds, the register's OWN record links the agent
  (#3712): the intake row whose `intakeDiscoveredAgentId` names it, if live and
  in `INTAKE_LINKABLE_STATUSES` — an allowlist, so RETIRED and any later status
  never link. That link closes `SHADOW_AGENT` only on a complete scan (an
  incomplete one links and holds the finding), and a report naming a different
  live row still wins, audited as `AGENT_INTAKE_LINK_CONFLICT`. Both owner
  decisions (2026-10-18): the asymmetry is deliberate — a REPORTED link still
  closes on any scan — and an intake is never a service-principal link
  confirmation, which stays its own act on the service-principal-link route.
- **A scan closes a finding only on positive evidence.** An agent absent from a
  scan resolves nothing about it, and "no unpinned write tool" counts only when
  the source each tool is judged by was read in full: `code` for a tool whose
  server is a `code://` locator, `mcp` for any other, and — for a tool the
  report may have left out — `code` for an agent discovered via `code`, `mcp`
  otherwise (`toolEvidenceSourcesOf`). Do not reduce that to the listed tools:
  an agent reported with no tools would then close on nothing. An empty scan is
  `EMPTY_SCAN`, not a clean bill (invariant 5 of the recertification section,
  applied here).
  `ORPHAN_CREDENTIAL` is derived from a `/2` report's `unboundCredentials[]`,
  keyed by scanner, source kind and reference: it opens only when that source
  AND every identity-bearing source the scan lists were read in full
  (`IDENTITY_BEARING_SOURCE`, every kind but `mcp`), and closes only when the
  SAME scanner reads the SAME source in full and no longer sees it unbound. A
  credential the source still lists is never closed, even by a scan that may
  not open it. An absent or incomplete source closes nothing, and a `/1`
  report — which has no member to say it — closes nothing.
- **The scanner's findings are written through `FindingRepository`, not
  `createFinding`**, because the principal is a key that holds the ingest
  permission and nothing else. Every write is still sanitised and audited.

**The stale-estate alert** (`usecases/agent-harness-estate-staleness.ts`, a
daily job since #3741) judges each estate with `computeEstateHealth` and nothing
else; `tests/unit/agentic/harness-estate-alert-uses-the-health-rule.test.ts`
refuses a local copy of the threshold or the window. Its `STALE_ESTATE:<estateId>` finding
closes only on a complete scan that ARRIVED after the estate's declaration last
changed (`declarationChangedAt`). An edit that turns the card FRESH (a wider
cadence, a dropped source) and a removal of the estate both HOLD it. Do not
"simplify" the close to `status === 'FRESH'`, because that closes on an edit.

**The harness matrix** (`usecases/agent-harness-matrix.ts`,
`/agents/reports?tab=harness`, #3687) reads the harness tables and writes none of
them; the tab's only mutations are the owner's acceptance and the key register,
through their own routes. Rules that are easy to undo:

- **"Latest" means `asOf`**, then `createdAt`, then `id` — never arrival order —
  and drift compares a scanner only with its OWN previous scan.
- **An empty population is a finding, never `EmptyState`**: no scan, an EMPTY
  scan (`harnessScanCompleteness` — complete sources AND at least one agent, in
  one expression the evidence emitter reuses), and an empty shadow list without
  EVERY trusted scanner's complete latest scan behind it — one scanner's complete
  scan says nothing about the sources another reads, and a key holder with no
  scan in the window is named on the tab.
- **Rows are the worst of a WHOLE latest scan, or none** (`rowsUnread`): the
  latest scans' items are read on their own, never in one bounded read with the
  previous scans', which only drift needs.
- **A cell is the ladder's `criterionState` over `collapseVerdicts`**; do not
  re-implement it in a component. A pointer is a link only when it is an
  absolute http(s) URL — a scanner-chosen `/path` must not become an in-app link.
- **The accept button and `acceptHarnessShortfall` share
  `shortfallAcceptanceRefusal`** (`src/lib/agentic/harness-acceptance-rules.ts`).
  The server computes the affordance; no user id reaches the client.
- **The calendar source is keyed `admin.agent_registry`** (the tab's own gate)
  and its titles carry the registered agent's name only — they are pushed to
  external calendars.
- **`AGENT_HARNESS_SCANS` evidence** goes to ASI10 and ASI03, one artefact per
  control per UTC month, and only for a tenant that has ever registered a scanner
  key. It is planned `APPROVED` only when every scanner's latest scan of the
  month is complete and non-empty AND every scanner that held a trusted key in
  the month reported, `NEEDS_REVIEW` otherwise, with the reasons in the body.
  The emitter corrects the Evidence status in ONE direction
  (`harnessStatusCorrection`): an incomplete month found APPROVED is put back,
  and a NEEDS_REVIEW is raised only when it was its own verdict
  (`plannedEvidenceStatus`); REJECTED, SUBMITTED and a stale-review sweep's
  NEEDS_REVIEW stand, and every change it makes is a `STATUS_CHANGE` audit row.
  A month is not closed by its last tick: the scheduled run re-emits the
  previous month and any month a late scan reached
  (`reconcileClosedHarnessPeriods`). Receipts and decision records keep `null`
  ownership. The body carries no owner reference, user id, justification,
  pointer, credential reference, tool server or agent name (DPIA condition 8),
  and the level never decides the status: the ladder is report-only.

**The reference scanner** (`packages/agent-harness-scanner`, #3678) runs in a
client's estate and posts what the ingest above verifies. Okta, Azure Key Vault,
LangSmith (the `runtime` source, #3738) and the `code` source (LangChain and
LangGraph, #3737) today; Entra, MCP, the register and the container are #3686.

- **Read-only is the wire's shape.** A source holds `ReadOnlyHttp`, whose only
  verb is GET — do not give `getJson` a method parameter. The OAuth token
  exchange is the one POST, behind its own interface. Every request is declared
  in `scanner-surface.ts`, whose hash is the report's manifest hash, and the
  tests hold each fake's request log to it: a new endpoint goes there first.
- **A secret's value is never requested.** Okta's `/apps/{id}/credentials/secrets`
  and Key Vault's `/secrets/{name}` return values; credentials are reported by
  reference.
- **It imports the contract, never a copy.** It checks its report with the
  ingest's schema and `firstSecretShapedMember` before it signs, through
  `harnessSignedMessage`. `eslint.config.mjs` allows `harness-contract`,
  `harness-findings`, `harness-ladder` and `canonical-json` from `@/` and refuses
  every other `@/`, `@prisma/*`, `next` and `@inflect/ui` import.
- **No register link from the estate's own labels.** `registeredAgentId` is
  `null` from these sources: an Okta profile or a vault tag is written by the
  estate's administrator, who could use it to hide a shadow agent.
- **An unreadable source is in the report**, `INCOMPLETE` with its reason —
  including one whose credential is missing (`AUTH_FAILED`).
- **Every Okta API token is a principal except the scanner's own**, which is
  identified by id from `GET /api/v1/api-tokens/current` — never by its name,
  which any administrator can give any token. A scanner that cannot identify
  its token stops the read before the list, with the request's reason.
- **The labels are documented defaults** (`profile.owner`, the tags
  `inflect-principal` and `owner`), overridable per estate in the configuration;
  `docs/agent-harness-scanner-onboarding.md` is where a client is told them.
- **The `code` source reads code and never runs it.** Static parsing only
  (`sources/code/`): a scanned repository must not be able to run anything
  beside the signing key. `eslint.config.mjs` refuses `child_process`, `vm`, a
  module loader, `require()`, `import()` and `eval` there, and the side-effect
  test proves it. An agent counts only when its names resolve through the
  file's imports to a `langchain`/`langgraph` module, and anything that does not
  resolve is `UNPARSEABLE` — never dropped, and never guessed into a value.

**Client estates** (`usecases/agent-harness-estates.ts`, the only writer of
`AgentHarnessEstate` and `AgentHarnessEstateSource`; health in the pure
`src/lib/agentic/harness-estate-health.ts`):

- **A scan is an estate's through the scanner that signed it**, and one estate
  per scanner is a unique key, because a report cannot name an estate. An
  estate's scanner is fixed; moving it is a new estate.
- **Every source has an owner who is an ACTIVE member when written**, and an
  estate declares at least one source. A departed owner is shown, never hidden.
- **Health fails towards STALE.** A scan counts only when the matrix calls it
  COMPLETE and every declared source was read in full with at least one row;
  freshness is from `min(asOf, ingestedAt)`; STALE after 1.5 cadences, and no
  complete scan among those read is STALE, never "unknown".

**The `UNCLASSIFIED` AI-system tier** (#3691 deploy 1, #3669 deploy 2) marks
a provisional `AiSystem` entry that nobody has classified. Every reader treats
it as not classified, never as `MINIMAL`: not in a tone, a count, a filter or
the conformity check. Readers use `StoredAiRiskTier`, and a reader that is not
on the guard's `READERS` list (activation, the classify usecase) narrows with
`isClassifiedTier` rather than naming the value. It has exactly ONE writer, and
`tests/guards/ai-risk-tier-unclassified-writers.test.ts` holds every part of
that:

- **`AiSystemRepository.createProvisional` is the only method that stores it**,
  with the value fixed in its insert's `data` and no tier parameter (a type
  proof). `create` and `classifyProvisional` take the classifier's four-tier
  `AiRiskTier` from `src/lib/eu-ai-act/classification.ts`, not the column's
  type. Do not widen either parameter, and do not add a `riskTier` to the
  store's input: a caller that can choose the tier is a second writer.
- **`createProvisional` is referenced by one file outside the seam**, the
  registration intake, which is the sole `WRITERS` entry. Any reference counts,
  including a destructure. Calling it from anywhere else fails CI by design.
  A second legitimate writer is a reviewed change to that list, not a
  workaround.
- **`classifyProvisional` names the value only in its `WHERE`.** It moves an
  entry out of `UNCLASSIFIED`, once, and nothing moves one back in. That is why
  activation's `AI_SYSTEM_UNCLASSIFIED` check needs no lock or trigger: the
  only write of the value is an INSERT of a new entry, and an agent's
  `aiSystemId` is not amendable. A verb that re-opens a classified entry
  would make that check racy.
- **No Zod schema is built from the generated `AiRiskTier`.** The intake and
  classify request schemas are `.strict()`, so a `riskTier` in a body is a 400.

**The registration intake** (`usecases/agent-registration-intake.ts`, since
#3669) turns a `SHADOW_AGENT` finding into a `DRAFT` register row through a
provisional entry, in one transaction, at `POST …/admin/agents/intake`. These
rules are each one careless edit from being undone:

- **The owner is the confirmed person, never the suggestion.** No owner named,
  or `confirmOwner` not `true`, is `OWNER_NOT_CONFIRMED`, whatever the request
  carries. The attribution answer is parsed through 1d's contract and kept as
  provenance only. Do not add a "use the suggested owner" shortcut. The 1d
  rule that a person confirms in the intake is enforced here.
- **The provenance never records the suggested person's reference** or any
  signal's `personRef`. Those are identifiers in the source's namespace, and an
  audit row's `detailsJson` streams to the tenant's SIEM. A boolean
  (`confirmedOwnerIsSuggested`) says whether they agree. `FALSE` means "not
  shown to agree", not "a different person".
- **One discovered agent, one register row, held by the database.**
  `RegisteredAgent.intakeDiscoveredAgentId` has a unique index with
  `tenantId`, and the claim read (`findIntakeClaim`) is deliberately not
  filtered on `deletedAt` or status, so it is never narrower than the index. A
  P2002 on the insert is mapped to `ALREADY_REGISTERED_BY_INTAKE`. The column
  has no FK, on purpose: a second reference between `DiscoveredAgent` and
  `RegisteredAgent` would make the pair a delete cycle.
- **The intake writes no `DiscoveredAgent`, scan or `Finding` row.** The next
  scan links the discovered agent and closes the finding, on positive
  evidence. Until then the agent still reads SHADOW. Do not close the finding
  at intake: that would close it on an assertion rather than an observation.
- **Activation's preconditions live in the status writer.**
  `applyRegisteredAgentStatus` calls `assertActivatable` for every move to
  `ACTIVE`: `AI_SYSTEM_UNCLASSIFIED` first, then `UNSCORED`, each as
  `details.reason`. A new path to `ACTIVE` that bypasses the status writer
  bypasses both.
- **Classification of a provisional entry** (`classifyAiSystemEntry`, `POST
  /ai-systems/:id/classification`) takes the AI-system register's own gate,
  `assertCanWrite`, and requires all four questionnaire answers: `{}` is a 400,
  never a quiet `MINIMAL`.
- **A rolled-back write leaves the audit extension's row.**
  `src/lib/prisma.ts` audits each statement on its own connection as it runs,
  so the loser of a racing intake leaves a `CREATE AiSystem` row behind. The
  intake's own three audit rows are written last and only by the winner. Tests
  that count "nothing written" across a rollback count the intake's actions,
  not every audit row.

**Agent recertification** (`usecases/access-review-agent.ts`, step 3a, #3674)
is an access review whose scope is `AGENT`: one subject per registered agent
that can hold authority, a reviewer pack each, narrowings a person decides, and
a close that files evidence and draws a sample for a second human. The value
reached `AccessReviewScope` in two deploys — a Prisma client meeting an enum
value it was not generated with fails the whole read, which on the register is
every campaign the tenant has — so the first deploy taught every reader and
wrote nothing. Rules that are easy to undo:

- **Readers key on `src/lib/access-review/scope.ts`, never on two scope
  names.** `SUBJECT_TABLE` says which decision table holds a scope's subjects
  (AGENT is `CONNECTED`, as LEGACY_APP is), keyed exhaustively on the stored
  value. An unknown scope routes to the connected close, which refuses zero
  subjects, never the member close, which has no zero-subject guard.
- **AGENT has ONE writer and its own routes.** `createAgentCampaign` on the
  repository takes no scope and is called only by `createAgentAccessReview`;
  the general `create` excludes AGENT by type and at run time, and
  `POST /access-reviews` (member scopes only, `z.enum(MEMBER_ACCESS_REVIEW_SCOPES)`
  — never a Zod schema over the generated enum) answers `SCOPE_HAS_ITS_OWN_ROUTE`.
  The generic member close, connected decide and connected close refuse AGENT
  by name (`AGENT_CAMPAIGN_OWN_FLOW`); the routes dispatch it to the agent flow
  FIRST, before the subject-table dispatch. `tests/guards/access-review-agent-scope.test.ts`.
- **`AGENT_CAMPAIGNS_IMPLEMENTED` is the brake, and it is true.** Every act of
  the agent flow asserts it, so setting it back to false — a reviewed one-line
  diff — stops create, prepare, decide and close with
  `AGENT_CAMPAIGN_NOT_AVAILABLE` while every reader keeps reading the rows.
- **Zero is never complete, twice.** Creation refuses an empty population
  (`NO_SUBJECTS`); the close is `subjectCount > 0 && decided === subjectCount`
  in ONE expression, and also requires a pack per subject and no pending
  narrowing.
- **The agent's owner may not decide its subject, its narrowings or its
  sample** — frozen owner (`subjectOwnerUserId`, stamped at creation) AND
  current owner, 403 plus a hash-chained `AUTHZ_DENIED`, even for an ADMIN. A
  CHECK refuses the frozen owner as `decidedByUserId` for any writer.
- **A pack is read, never written, by the workflow.** `agent-recertification-pack`
  is one READ step on `get_agent_recertification_evidence` and one pure
  SYNTHESIS; its usecase (`agent-recertification-evidence.ts`) writes nothing.
  `prepareAgentReviewPacks` reads each run's recorded steps, RE-DERIVES the
  plan from the READ output and refuses a recorded plan that disagrees, then
  writes every pack and narrowing in one transaction. One run per
  `PACK_PAGE_SIZE` agents, so a run's context stays bounded. The plan carries
  NO hash: a client component imports the workflow registry, so every workflow
  step is in the browser bundle and may not need a Node built-in — a
  `node:crypto` there failed `next build`, and a bare `crypto` only compiles by
  bundling a polyfill. The usecase hashes each pack's stored sections with
  `sha256Of` from the server-only `agent-recertification-hash.ts`;
  `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts` walks
  the import graph and holds it for every workflow.
- **A REGISTERED AGENT prepares every pack, and never its own** (roadmap rules
  1 and 8; decision 19). The campaign names `preparerAgentId` — ACTIVE, scored,
  un-killed, un-latched, granted the read tool — which prepares every pack but
  its own, and optionally a different `crossPreparerAgentId` that prepares
  exactly that one. With no cross-preparer, the preparer's own pack is prepared
  by the PERSON starting the preparation on the same static workflow with no
  agent bound (`WorkflowRun.agentId` NULL, pack `preparationBasis =
  PERSON_STATIC_SELF_PACK`, `preparedByAgentId` NULL) — that one pack only,
  refused by name for any other (`STATIC_PACK_NOT_PREPARERS_OWN`). The agents'
  runs are started with the requester's context and the agent bound
  (`{ ...ctx, agentId }`, the seam `agent-invoke-dispatch` uses), so the read is
  the agent's: deny-by-default over ITS grants, its card, its autonomy ceiling;
  the requester's permissions are one term of the intersection, never a way
  around it. Eligibility is asked at creation AND at preparation, each refusal
  named (`PREPARER_*`); a credential or an agent cannot start preparation
  (`PREPARE_REQUIRES_PERSON`). Rule 8 is held three times: the evidence read
  excludes `ctx.agentId`'s own subject and refuses it when asked
  (`SELF_PACK_REFUSED`), the usecase refuses a run that returned it, and CHECKs
  on the pack refuse `preparedByAgentId = agentId`, pair the basis with the
  agent, and — through an FK binding `campaignPreparerAgentId` to the
  campaign's own preparer — refuse an agent-free pack for anybody but the
  preparer.
- **A narrowing only deletes.** It is proposed for a grant held for the WHOLE
  90-day window before creation with no recorded call in it — never for a grant
  younger than the window, never from a truncated grant list. Accepting deletes
  that grant row by id (`RegisteredAgentToolRepository.revokeGrant`) under
  `access_reviews.decide`, and writes the standard `AGENT_TOOL_REVOKED` row.
  The campaign file writes no register, grant-creating or card table —
  `tests/guards/agent-recertification-single-write-seam.test.ts` pins its exact
  write set. Narrowings are their own model, not `AgentProposal`: a proposal
  kind would be another two-deploy enum, and the proposal queue's expiry and
  four-eyes rules are not a recertification's.
- **Every stamp is one-way in the database.** Triggers refuse changing a
  recorded verdict, an executed stamp or a frozen subject on EVERY
  `AccessReviewConnectedDecision` (all scopes), any update of a pack, and any
  change to a decided narrowing or an answered sample. `app_user` holds no
  DELETE on the three new tables.
- **The evidence hash recomputes from stored rows.** `buildAgentCampaignEvidence`
  sorts every collection and renders every date as ISO (`canonicalJson` sorts
  keys, not arrays, and turns a `Date` into `{}`); the hash is the hex SHA-256 of
  exactly the stored bytes, so it equals the `FileRecord.sha256`.
  `getAgentReviewPacks` recomputes it on every read and reports `matches`. Filed
  against A.5.18, CC6.3 (present in both SOC 2 representations since #3369
  completed CC6; a test asserts that presence, having asserted its absence
  before) and ASI03.
- **The sample uses the existing keyed sampler** (`selectSample`,
  `sampleSizeFor`), seeded per tenant through `deriveSubkey` and epoch-bound to
  the campaign, at close. The second human may read the pack and is neither the
  first decider nor the owner.
- **An AGENT campaign's subjects, packs and evidence are register data**, read
  under `admin.agent_registry`, while every role holds `access_reviews.view`.
  Every read of them — detail, subject list, packs, the evidence read tool, the
  evidence file route — narrows to the campaign's reviewer or a register reader.

**A2A peers** (`usecases/peer-agents.ts`, since #3673) are agents in another
organisation, registered for identity and attribution and never for authority
(`docs/a2a-mapping.md`). Five rules in it are easy to undo:

- **`PeerAgent` has no authority column, and must never get one.** No grant,
  scope, key or rung. Whatever a peer causes is decided by the registered agent
  that receives it, through the existing funnel; a column here would be the
  second authority model the design rules out.
- **No trust on first use.** Registration records the card it saw and pins
  nothing, and an unpinned peer is refused. Do not add a baseline pin the way
  `recordBaselinePins` does for built-in tools: a card is another
  organisation's text.
- **Approval names the reviewed hash and re-reads the card**, refusing when it
  moved, and an `apiKeyId` on the context refuses outright: a pin is a person
  accepting what they read.
- **Card text is never stored, logged, audited or notified.** It goes only to
  the reviewer in the card-read response. Audit rows carry hashes and the
  components that moved.
- **The routes take `admin.agent_registry`, not `admin.agent_external_tools`**
  (owner decision, 2026-10-18; threat-model R3). The key for an agent's call
  out must not also configure whom it talks to.

Card text is hashed through `JSON.stringify`, not straight to SHA-256: UTF-8
encoding turns every lone surrogate into U+FFFD, so two different texts would
hash alike.

**A2A messaging** (`usecases/a2a-inbound.ts`, `a2a-outbound.ts`, since #3679)
carries tasks both ways with one pinned peer. Ten rules in it are easy to undo:

- **The outbound rung lives on the `a2a-peer` connection, never on the peer.**
  The send is that connection's external tool, and its A2A branch in
  `adapterFor` runs BEFORE the read/write split, so every send takes the ladder
  whatever the tool declares. Nothing is sent from the call; the dispatch pass is
  the only sender, through `wirePost`.
- **`ctx.a2aInbound` only narrows.** A peer-started run's external writes are
  clamped to `PROPOSE_ONLY` (`clampForInboundA2a`, R17) and it gets no A2A send
  (R14). `executeFrom` restores it from `WorkflowRun.inboundPeerId`; a resume
  that dropped it would win `AUTOMATIC` back.
- **Admission before parsing.** `handleInboundA2a` parses nothing the peer wrote
  until kill, credential, receipt and admission pass. The peer is told
  "refused" whatever the reason; the reason goes to `AUTHZ_DENIED`.
- **Each tenant signs with its own key** (`TenantA2aSigningKey`, owner decision
  2026-10-19). The seed is in the Epic B manifest and is read only by
  `resolveTenantA2aSigningKey`; rotation is `admin.tenant_lifecycle`, never an
  API key, and RETIRES the old key (seed NULLed, public half kept) so receipts
  verify by the key id they name. There is no deployment key — do not bring
  back an env var. No key ⇒ `NO_SIGNING_KEY` both ways, asked inbound only
  after the peer has proved itself.
- **A receipt keeps the EXACT bytes and the key it verifies under.**
  `PeerAgentMessage` is write-once by trigger and its body is never sanitised
  or re-serialised. Verify against the key the row NAMES
  (`verifyStoredA2aReceipt(row, key, fingerprint)`), never one it supplies for
  itself. A reply whose receipt fails is discarded and settles `INDETERMINATE`.
- **Write-once triggers on encrypted columns must admit the re-wrap.** The
  tenant-DEK and master-KEK sweeps rewrite every manifest ciphertext with a raw
  UPDATE; the receipt, kill and key triggers let through ciphertext → `v2:`
  ciphertext with every other column unchanged, and nothing else. A new
  write-once table with an encrypted column needs the same exception.
- **The card copy is at most 15 minutes old** (`A2A_CARD_MAX_AGE_MS`, R18), and
  the per-peer quota is `PeerAgent.inboundMessagesPerHour` (1..1000, register
  key). Neither moves without the owner.
- **`iflp_` is not `iflk_`.** `/api/a2a` is its own `MACHINE_CALLER_PREFIXES`
  entry and self-authenticates; `matchTenantApiKeyRequest` is untouched, and the
  egress scan refuses both prefixes. Retiring the receiving agent revokes the
  peer's credential in the cascade, so the next message fails at the credential
  check.
- **An approved external write opens at `PROPOSE_ONLY`**, also on an
  `AUTOMATIC` connection: its authority is a person's approval, and the
  `AUTOMATIC` arm would demand a parameter set it never ran.
- **The per-peer kill is a sibling table** (`PeerAgentKillSwitch`), read
  uncached on every message both ways; an API key cannot lift it. It and
  `PeerAgentMessage` key the peer by plain id with no FK, so the tenant purge,
  which retains both, cannot cascade into them. Single writers:
  `a2a-messages.ts`, `a2a-peer-kill.ts`, `a2a-peer-credentials.ts`,
  `a2a-signing-key.ts`.

**The inventory view key** (`admin.agent_registry_view`, #3710) is read-only:
the register list and row, scans and the matrix, `get_discovered_agent`, the
governance pack, and — beside `admin.view` — runs and proposals. OWNER, ADMIN,
AI_ADMIN and AUDITOR hold it. Three rules in it are easy to undo:

- **Every inventory read also admits `admin.agent_registry`**
  (`mayReadAgentInventory`): a custom role saved before the split takes the view
  key from its base role, and reading the view key alone takes the inventory
  away from it.
- **Only its own name grants it.** `admin:agent_registry_view` is the one
  scope; `*` and `admin:*` do not carry it (`WILDCARD_EXCLUDED_ACTIONS`). Folding
  it into a wildcard would have every key already issued read owner references.
- **It grants no write.** Filing the pack, every register write, scanner keys,
  peers, intake and acceptances stay on the register key;
  `tests/unit/agent-registry-view-key.test.ts` reads every write handler off the
  filesystem and refuses a view-only caller. The edge admits an AUDITOR to a GET
  of the five inventory routes only (`AUDITOR_ADMIN_READ_PATHS`): exact templates,
  so `…/harness-estates` is admitted and `…/harness-estates/[estateId]` is not.

**A Flue run's declared input reaches the model as data**
(`src/lib/agentic/flue/run-message.ts`): the definition's `requiredInput` keys
and nothing else, read from the sealed context under verification, neutralised,
fenced and labelled `agent.run-input`. The decision digest is over that message,
so keep the one `runMessage(...)` binding both readers share.

**Auditor independence and workpapers** (step 3b, #3675) carry rule 8, "the
auditor is not the auditee". Five rules, each held by a test:

- **NULL is "not declared" and never satisfies a check.**
  `TenantMembership.lineOfDefence` has ONE writer, `setMembershipLineOfDefence`:
  a literal `requirePermission('admin.owner_management')`, AND a built-in role
  of OWNER (a custom role carrying the key does not make an ADMIN one), a person
  rather than a credential, and never one's own membership. Every change is
  audited.
- **The independence check REFUSES only while an agent's standing as an auditor
  is being granted**: registration, an amend that sets `isAuditor`, and every
  move to ACTIVE (`assertActivatable`). The insert recipe asks it too, so no
  caller inserts around it; the trigger `registered_agent_auditor_independence`
  backs all three. DRAFT and SUSPENDED agents are audited agents. Every LATER
  break — transfer completion, an agent registered to the owner, an auditor
  unmarked, the owner's line moved — raises one HIGH finding per auditor
  (`sourceKind = AUDITOR_INDEPENDENCE`) and never suspends or refuses. Do not
  turn the finding into a refusal: it would block an accountability handover two
  people agreed.
- **Take `lockAuditorIndependence` FIRST** in any new path that can make or break
  independence — before any row lock, or two such paths can deadlock — and the
  trigger takes the same key.
- **A workpaper is one-way and the auditor's.** Only a job or a context whose
  `agentId` is the ACTIVE, independent auditor writes one; every column is
  frozen at insert apart from a review stamp set once by a SECOND- or THIRD-line
  member who does not own the auditor (`WORKPAPER_STAMP_LINES`, #3735; the
  trigger freezes the rest for every role; no `app_user` DELETE); the first
  sample per (procedure, period) is binding (trigger). No free-text column: a
  new one is a decision in `encrypted-fields.ts`, not an addition.
- **A workpaper links findings and never closes one.** `AuditWorkpaperFinding` is
  insert-only, and the workpaper usecase and repository write no `Finding` —
  `tests/integration/audit-workpaper.test.ts` reads both files for it.

**The auditor's procedures** (`services/audit-procedures/`, step 3c, #3676) run
library v1 — catalogue procedures 1 to 5 — on the control-test runner as the
registered auditor agent. Six rules, each held by a test or a lint rule:

- **Library v1 is PROPOSED.** `LIBRARY_V1_STATUS` records internal audit's
  approval, the managed-service provider's agreement and each provider
  methodology reference as OPEN. Changing one is a claim about an external
  party's act; it belongs only in the pull request that records that act on
  #3663.
- **One runner, one INTEGRATION handler.** `agenticControlTestHandler` sends a
  `procedure` config to `auditProcedureHandler`; never a second runner or a
  second INTEGRATION registration (the registry throws on one).
- **The auditor reads and proposes.** Its remit is Inflect's read tools and
  `propose_finding` (`AUDITOR_TOOL_REMIT`), refused at grant, mark and
  activation, and the handler will not run an auditor that exceeds it, is
  killed, inactive or not independent. Exceptions leave only as
  `propose_finding` proposals through the funnel under the auditor's identity
  (principal: its owner's own membership); a procedure result sets
  `findingsRaisedAs: 'PROPOSALS'`, so the runner writes no Finding. The ESLint
  block over the directory refuses finding writes and stored-figure reads
  (`resultJson`, `executedAt`, breaker and card counts).
- **Zero is never complete, in the catalogue's order** (`decideConclusion`):
  precondition → FAIL → untestable → PASS, and PASS only as
  `populationCount > 0 && tested === sampleSize && exceptions === 0`. An empty
  population is INCONCLUSIVE and stamps no `lastTested`.
- **The workpaper is written in the runner's transaction** (`afterEvidence` →
  `recordAuditWorkpaperInTx`): a second transaction cannot see the uncommitted
  `ControlTestRun` and is refused `RUN_NOT_FOUND`. Each exception names its
  proposal; a re-run names the live one rather than proposing again.
- **Only the auditor's owner sets or switches off a procedure plan.** Every path
  that can pause, archive, unschedule, re-type or delete a test plan asks
  `assertAuditorOwnerMayChangeProcedurePlans` (`usecases/audit-procedure-plans.ts`)
  and refuses anyone but a PERSON who owns the auditor the plan names — never
  an API key, agent or job, the owner's own key included —
  `AUDIT_PROCEDURE_PLAN_OWNER_ONLY`. A new path that stops a plan running asks
  it too, or the audited first line can switch off its own audit. The plan is
  where the second line's parameters live, and the library keeps no default
  for them (pilot values: `usecases/audit-pilot-setup.ts`, run from the
  `/agents/audit-pilot` page as the owner, or from `scripts/audit-pilot-setup.ts`).

**Internal audit's sampling of the workpapers** (step 3d, #3677) is the check on
the auditor. The DAILY sweep (`jobs/audit-workpaper-sample-review.ts`) draws
the auditor's workpapers into `AuditWorkpaperSampleReview` and assigns each to
an ACTIVE THIRD-line member; that member answers on `/audits/workpaper-reviews`
(`usecases/audit-workpaper-sample-review.ts`). Ten rules, each held by a test —
the last three, and the daily cadence, are owner decisions of 2026-10-19:

- **Drawn and assigned by the sweep, answered by the assignee, and nothing
  else.** No route draws, opens or assigns a review; the review usecase never
  creates a row or moves an assignment, and the sweep never writes an answer
  (`tests/guards/sample-audit-single-draw-seam.test.ts`). A
  person who could pick the workpaper or the reviewer would be choosing what the
  agreement rate measures.
- **The draw is a keyed decision PER WORKPAPER, not a rank over a run's
  population.** `sampleScore` (the ASI09 sampler's HMAC) against the tenant's
  rate, with the epoch fixed by the workpaper's PERIOD
  (`audit-workpaper-review@<periodLabel>`), never the run date. A rank would
  re-draw a grown population and creep towards everything; a per-workpaper
  decision is re-derived identically by every sweep and is monotone in the
  rate — which is why the sweep can run DAILY: re-deciding a workpaper gives
  the same answer and the `(tenantId, workpaperId)` unique holds one row, so a
  second run the same day changes nothing. The rate is the per-tenant
  `TenantSecuritySettings.workpaperReviewSamplePercent` (100 — the pilot
  reviews every workpaper; an unreadable value reads as 100, never less), and
  each row records the percent, epoch and seed fingerprint it was drawn with.
- **Only an ACTIVE THIRD-line member who does not CURRENTLY own the auditor is
  ever asked or answers** — `isEligibleReviewer`, asked by the sweep's pool, by
  the read, by the answer, and again by the trigger
  `audit_workpaper_sample_review_assert_reviewer` on every assignment and every
  answer. The owner is excluded even when THIRD-line. Nobody eligible is
  `UNASSIGNED` with a named reason (CHECK-pinned), never dropped and never
  given to somebody ineligible; the next day's sweep re-draws only a PENDING row
  that nobody can answer, from the same epoch, and never moves a valid
  assignment.
- **The answer is write-once, codes not prose.** CONCURRED / DISSENTED /
  INDETERMINATE by the assignee (CHECK: `reviewedByUserId = assignedToUserId`),
  once; dissent is `WORKPAPER_REVIEW_DISSENT_CODES`, pinned by a CHECK to that
  vocabulary, and the table has no free-text column. Adding a code widens the
  CHECK in a migration; never repurpose one. The answer also sets the
  workpaper's 3b review stamp when nobody has (`stampWorkpaperReviewedInTx`).
- **A DISSENTED answer queues exactly ONE finding proposal through the
  ordinary queue** (`createAgentProposal`), under the reviewer's own session —
  never as the auditor agent through the tool funnel, which would attribute the
  check to the auditee and let the auditor's kill switch stop it. With no agent
  and no key it pins `NO_POLICY_CARD` and tiers as `HUMAN_AUTHOR`; a person
  decides it with `approveAgentProposal`, and nothing here writes a `Finding`.
  Exactly once: a per-review advisory lock, the row's write-once
  `findingProposalId`, and the origin ref in `AgentProposal.proposedBySessionRef`
  (`audit-workpaper-review:<reviewId>` — a plain column, the payload is
  encrypted) for a raise interrupted before the link. A raise that fails after
  the answer committed is raised by the next sweep. A proposal that EXPIRES
  undecided is NOT raised again (owner decision, 2026-10-19): the link is
  write-once, and the expiry is itself the record that nobody decided.
- **The agreement rate counts CONCLUDED reviews only** (`workpaperReviewRate`).
  A drawn but unreviewed workpaper is in neither the numerator nor the
  denominator; INDETERMINATE and UNASSIGNED are excluded and reported beside
  the rate; and with nothing concluded both rates are `NOT_ASSESSED`
  (`NO_CONCLUDED_WORKPAPER_REVIEWS`) — never "100% agreement". The figures are
  report 6 of the governance pack (`workpaper-review`, metric ids
  `assurance.workpaper_*`), each with its definition.
- **Reading a review's workpaper takes being its assignee or internal audit,
  never `audits.manage`.** The routes take `audits.view` (every role: an
  internal auditor is often an AUDITOR); the usecase narrows every verb and
  audits each who-may refusal as `AUTHZ_DENIED`. "Internal audit" is ONE rule
  (`readInternalAuditStanding`): a person, an ACTIVE THIRD-line member, who owns
  no agent that is or has written as the auditor.
- **Internal audit sees every assignment; everybody answers only their own.**
  `listWorkpaperReviews` returns every row in the tenant to internal audit
  (`scope: 'ALL'`), with the assignee and status, and only the caller's own to
  anybody else; somebody else's row opens read-only (`viewer.answerable` is
  false) and its answer is still refused `NOT_ASSIGNED_REVIEWER`. The auditor's
  owner never sees the overview, even on the third line.
- **Only internal audit sets the sampling rate** (`setWorkpaperReviewSamplePercent`,
  `PUT …/workpaper-reviews/sample-rate`): an API key, an agent or a job is
  `NOT_A_PERSON`, anybody off the third line `REVIEWER_LINE_NOT_THIRD`, the
  auditor's owner `REVIEWER_OWNS_AUDITOR`, each a 403 with an `AUTHZ_DENIED`
  row; the change is audited before and after; 1..100 in the schema and in the
  CHECK — 0 is not a rate. The second line operates the auditor, so it must not
  be able to steer how closely the auditor is checked.
- **The dissenter never decides their own dissent's proposal** — approve,
  approve with edits, reject or bulk reject. `assertNotDissentAuthor` in
  `agent-proposals.ts` reads the review named by the proposal's origin ref and
  refuses its `reviewedByUserId` with `DISSENT_AUTHOR_MAY_NOT_DECIDE`, keyed off
  the REVIEW rather than who created the proposal, because the sweep's heal
  raises it under a system context. A ref naming a review the tenant does not
  hold refuses everybody (`DISSENT_AUTHOR_UNKNOWN`). Every deciding path calls
  it, and the database holds the same bar behind it (#3760): triggers on
  `AgentProposal` (a PENDING to ACCEPTED, EDITED or REJECTED move) and on
  `AgentProposalApproval` (a signature) refuse the review's dissenter under every
  role, and a dissent proposal's `proposedBySessionRef` is write-once
  (`DISSENT_ORIGIN_IMMUTABLE`), so the ref cannot be cleared first. The usecase
  still refuses first, because only it writes the `AUTHZ_DENIED` row.

**A review's ownership suggestion is a read model, not a write** (#3728, owner
decision 2026-10-19). `captureReviewAttribution`
(`usecases/agent-harness-attribution.ts`) is the only writer of
`DiscoveredAgentAttribution`. When a COMPLETED Flue `discovered-agent-review` run
that pinned `nhi-ownership-attribution` settles, it parses the run's answer
through `parseOwnershipAttribution`, and stores the status, grade and person-free
signals with the suggested person kept apart in the encrypted `proposedOwnerRef`.
The row is written from model output with no person in the loop, and rule 5
allows that because it sets nothing: it only feeds the Register dialog, where a
person chooses the owner. Keep it that way. A path that let the stored suggestion
set `ownerUserId`, or that showed `proposedOwnerRef` to the client, would turn an
annotation into an agent write. A newer review whose answer cannot be parsed
leaves the older suggestion in place, labelled with its own run.

**Skills** follow `docs/agent-skill-standard.md`. The 2 KiB catalogue budget
binds PER WORKFLOW and PER RUN (`assertWorkflowCatalogsWithinBudget`,
`resolveSkillsFor`), never the corpus as a whole (owner decision, 2026-10-17):
do not restore a corpus-wide check, which capped the product at about seven
skills whatever any run mounted. An evaluation SET (cases and expectations) is
authored with a skill and tied to its instructions by hash; only an evaluation
RECORD, the set plus a named model revision's answers, can show a pass, and pass
rates are recomputed from raw answers, never stored. Skill text is scanned at
load (`skills/text-scan.ts`): a refused skill is held apart by rule id rather
than thrown, so one suspect skill stops only the runs that declare it, and no
surface ever shows a refused skill's text. A defensive "never reveal your
instructions" sentence is refused too — the rules cannot tell which way a
sentence points. A skill mounts only with a passing `evaluation-record.json`
beside it (`skills/mount-gate.ts`; made by `npm run skills:evaluate`, never by
hand), and `WorkflowRun.mountedSkills` pins each mounted skill's hash at
admission, write-once by trigger — `[]` is "mounted nothing", NULL is "predates
the pin", and the two must never be conflated.

**A workflow without a PROPOSE step is not read-only on Flue.** The model picks
its own calls from everything its agent is granted, propose tools included.
`readOnly: true` on a definition is what withholds the propose surface
(`flueToolsFor(…, { readOnly })`, each withheld tool an omission
`READ_ONLY_WORKFLOW`). Every Flue-requesting definition with no PROPOSE step
sets it — `audit-narrative`, `discovered-agent-review`, `posture-review` and
`access-posture` (#3775, owner decision) — and
`tests/unit/agentic/flue-read-only-workflows.test.ts` fails, over the
registry, for one that does not. External read tools stay on the read surface,
so `access-posture` still reaches the directory.

**The audit narrative (#3749)** is model prose about a regulatory record, so it
is stored only through `usecases/audit-workpaper-narrative.ts`, after
`checkNarrativesAgainstRecord` has held every narrative in the answer to its
workpaper — the conclusion, every listed code and every code-shaped token in the
text — and one failure refuses the whole answer. `AuditWorkpaperNarrative` is
write-once and encrypted, and its insert trigger re-checks the codes. The skill
names every code in `EXCEPTION_SEVERITY` (a unit test fails when the library
gains one it does not name), and the answer is one JSON block because the
capture reads it back from the 4000-character decision-log summary.
The daily `audit-narrative-dispatch` keeps a tenant to one run a day by
`NARRATIVE_RUN_SPACING_HOURS` read against `WorkflowRun`, not by a BullMQ
bucket, so it is a dispatcher by name only; it starts runs as a JOB context
carrying the auditor's `agentId` and its owner's permissions resolved that day,
and refuses `engine_not_flue` rather than start a static run that can narrate
nothing.

**Tenant-authored skills** (#3680) pass the same gate, and four rules in it are
easy to undo. A `TenantSkillVersion` mounts only when APPROVED by someone other
than its author (usecase AND a CHECK), its record is recomputed at every mount,
and its decrypted instructions still hash to `approvedContentHash`: the
encrypted column cannot be frozen against the DEK rotation sweep, so that
recomputation IS the freeze, and dropping it as redundant leaves the text
unbound. An edit is a new DRAFT version; the approved one keeps serving until
the new one is approved. The mount reads only the run's own tenant
(`tenant-mount.ts`), and the budget counts repository and tenant skills
together. A tenant pin adds `origin: 'tenant'` and `versionId`; a repository
pin keeps exactly its three keys, so a run pinned before tenant skills existed
does not drift on resume. Two keys since #3778: `admin.agent_skill_author`
creates, versions, attaches a record and submits, and `admin.agent_skill_review`
approves, rejects and retires; a read takes either, and no API key holds either.
A custom role stored before the split takes authoring from its own review key
(`DERIVED_FROM`).

**The two IAM skills' answers** (`src/lib/agentic/iam-skill-outputs.ts`, since
#3668) are parsed before anything acts on them, and three rules there are easy
to undo:

- **An attribution is a suggestion by type.** `AttributionStatus` is the
  reconcile engine's `Outcome` minus `LINKED` and `NON_PERSON`; no arm carries
  an owner the run recorded. Do not add a `CONFIRMED` status or an
  `ownerUserId` member: a person confirms in the registration intake (2a), and
  the grade and outcome are re-derived from the answer's own signals.
- **A met verdict with no evidence reference is REFUSED, not coerced.** The
  ladder would read it as not met, so accepting it lets an answer claim a pass
  its own level does not contain. An answer stating a `level` is refused too.
- **The facts read (`get_discovered_agent`) takes `admin.agent_registry`**, the
  key every harness read takes, and no API-key scope carries it — so a Flue run
  (always agent-key-bound) is never offered it, and the Flue engine does not
  pass the run input to the model either. Closing that is an owner decision
  about who reads the agent inventory (a view key), never a weaker key chosen
  to make the tool reachable.

**The retirement cascade and agent ownership transfer, since 2a (#3698).**
`retireRegisteredAgent` is one act under `admin.agent_registry` alone, and its
effects live in `usecases/agent-retirement-cascade.ts`. Rules that are each one
careless edit from being undone:

- **Every effect is written DIRECTLY**, never through `revokeApiKey`
  (`admin.manage`), `revokeAgentTool`, `updateAgentPolicyCard` or the scanner-key
  revoke. Calling a standalone verb adds its gate to retirement without anybody
  deciding it should (0e: every effect takes authority away).
- **Status first, audit last.** The status UPDATE takes the agent row lock that
  the insert triggers' `FOR SHARE` waits on, so nothing inserted for the agent
  slips in behind the cascade; `logEvent` writes on its own connection, so a row
  written before an effect that then threw would narrate a rollback.
- **Every authority-bearing insert for an agent takes `FOR SHARE` on its row in
  a trigger** — a `PENDING` proposal, a card version, an ownership transfer, an
  unrevoked `TenantApiKey` (insert or re-bind) or `AgentHarnessScannerKey`, and a
  `RegisteredAgentTool` grant. The human usecases that mint keys and grants read
  the status UNLOCKED, and an FK check's `FOR KEY SHARE` does not conflict with
  retirement's `FOR NO KEY UPDATE`, so without the trigger a key minted at the
  moment of retirement survives it, unrevoked. A new table carrying authority
  for an agent needs the same trigger, or "retirement leaves nothing" stops
  being true of it.
- **`RETIRED` is terminal** — `setStatus` matches no retired row and a trigger
  refuses any move out of it. Every one of these triggers raises the
  `AGENT_RETIRED:` prefix (default SQLSTATE, not `restrict_violation`, which
  Prisma renders as an FK error), and each writing usecase maps it back with
  `isAgentRetiredDbRefusal` to the error it gives when it sees the status itself.
- **Retirement withdraws per-agent evidence of OPEN periods, and nothing
  tenant-wide** (#3700, under the owner's decision 13 of 2026-10-18). The
  cascade's last effect is `withdrawRetiredAgentEvidenceInTx`, reason
  `AGENT_RETIRED`, basis `PER_AGENT_OPEN_PERIODS`. Do not widen it to a
  tenant-wide artefact — that retracts true evidence about every other agent, and
  a CHECK refuses an `AGENT_RETIRED` withdrawal on a row with no agent — or to a
  closed period, whose record of what the agent did stays true. Audit rows from
  before #3700 say `POPULATION_LEVEL_ONLY`; they were true then.
- **The owner moves only by the two-step transfer**
  (`usecases/agent-ownership-transfer.ts`). `UpdateRegisteredAgentSchema` refuses
  `ownerUserId` by NAME (a stripped field would answer 200 with nothing changed),
  and `RegisteredAgentRepository.update` excludes it by type; `moveOwner` is the
  only post-registration write of the column.
- **Only the person a transfer names completes it; the person who started it
  never can.** The usecase asks that first, from the stored row; the claim's
  WHERE names the recipient; and CHECKs make any other completion
  unrepresentable. Both routes carry a literal
  `requirePermission('admin.agent_ownership')` (#3699; `admin.tenant_lifecycle`
  until then), ruled above the `/admin/agents(/.*)?` catch-all, so the
  recipient must hold the key too. OWNER and AI_ADMIN hold it; ADMIN does not —
  ADMIN holds the register key, and an agent's accountable owner must not be
  movable by the role that owner is accountable to.
- **A recipient must be able to reach step two, and step two has TWO gates.**
  The routes sit under `/api/t/:slug/admin/`, where the edge middleware refuses
  any session whose BUILT-IN role in that tenant is not ADMIN or OWNER — or
  AI_ADMIN, which it admits to the agent paths only — before the route runs; a
  custom role never enters that check. So step one accepts an OWNER, an
  AI_ADMIN, or an ADMIN whose custom role carries the key — never a
  READER/EDITOR/AUDITOR membership, whatever custom role it holds
  (`TRANSFER_RECIPIENT_MEMBERSHIP_ROLES`).
  `tests/unit/agent-ownership-transfer-edge-gate.test.ts` runs the real
  middleware and fails if the set and the edge disagree. The usecase gates on
  `assertCanRead` + the key, not `assertCanWrite`: AI_ADMIN, and an ADMIN
  membership with a READER-based custom role, resolve `canWrite: false` and are
  valid recipients. The edge reads the role in THIS tenant's membership, from
  the session's `memberships[]` entry for the URL's slug (`checkAdminAccess`,
  #3701), which is the row the step-one check reads.
- **At most one `PENDING` transfer per agent is a PARTIAL unique index in the
  migration.** Do not add a `@@unique` for it. A row that has left `PENDING` is
  immutable (trigger) — 2b's `OWNER_DEPARTED` lift is to read `COMPLETED` rows —
  and `app_user` holds no DELETE on the table.
- **Lock order is agent row, then transfer row**, on every path that takes
  both: step one reads the agent `FOR SHARE` before it stamps a lapsed transfer
  (`lockLifecycleStateForShare`), completion moves the owner before it claims
  the transfer, and retirement writes the status before it closes the open
  transfer (CANCELLED if live, EXPIRED if lapsed). Step one used to stamp first
  and lock the agent second, and deadlocked with a retirement whenever the row's
  deadline fell between the two requests' clocks.

**Per-agent evidence** (#3700, `AGENT_ACTION_RECEIPTS_PER_AGENT` and
`AI_DECISION_RECORDS_PER_AGENT`) is the month's receipts and decision records cut
by agent, on the tenant-wide kinds' own controls. Rules each one careless edit
from being undone:

- **Per-agent KINDS, not an `agentId` on the old kinds.** A container built
  before the column looks an artefact up by `(tenant, control, kind, period)`;
  on a shared kind that lookup could find a per-agent row and overwrite it with
  the whole tenant's counts. The CHECK `AgenticEvidenceArtefact_agent_scope`
  pairs a per-agent kind with an agent and a tenant-wide kind with none.
- **The identity is five columns, `NULLS NOT DISTINCT`, and Prisma cannot spell
  that.** Every tenant-wide row's agent is NULL, so the default semantics would
  admit a second tenant-wide row per identity. Lookups are `findFirst` (a compound
  unique input cannot name a NULL); do not regenerate the index from the schema.
- **Attribution is our binding, never the record's claim.** A receipt is the
  agent's whose SUBMITTING key is bound to it (`mcpKeyId` → `TenantApiKey.agentId`,
  read at emission — so a verb that re-binds a key must first stamp receipts at
  ingest), never pipelock's `agent_id` (its namespace, a run nonce at worst,
  sender-chosen on an unverified receipt). A decision is `AiDecisionLog.agentId`,
  stamped by `logAiDecision` from `ctx.agentId ?? null` and in the append-only
  trigger's column set. It has no FK on purpose: the log survives a tenant purge.
- **One read, cut in memory.** The per-agent facts are partitions of the
  tenant-wide read; the attribution column is selected beside a fact and never
  put into one, so the tenant-wide digest and body are byte-for-byte unchanged —
  `tests/unit/agentic-evidence-per-agent.test.ts` pins them to pre-#3700 values.
  The per-agent digest (`perAgentPopulationDigest`) binds the agent.
- **Nothing is written CURRENT for a retired agent, held three times**, because
  the plan and each write are separate transactions: the plan skips RETIRED; each
  per-agent write takes `FOR SHARE` on the agent row FIRST — before any Evidence
  row, the order retirement locks in — and refuses; and a trigger refuses the
  same write from any writer (`AGENT_RETIRED:` prefix). A row withdrawn
  `AGENT_RETIRED` is terminal: the update branch that revives a withdrawn row
  whose basis holds again never revives it. The withdrawal sweep re-asks
  `AGENT_RETIRED` for open periods, which covers a retirement run by a build
  that did not know the kinds.
- **The emitter's file stays the only writer.** `withdrawRetiredAgentEvidenceInTx`
  lives there and carries no gate of its own: retirement is one act under
  `admin.agent_registry`, and borrowing the emitter's `assertCanWrite` would add
  a gate nobody decided.

**The integration passport** (#3672, `docs/integration-passport.md` is the
specification) is one record per `mcp-server` connection, built by the pure
`src/lib/agentic/integration-passport.ts`, compared by the pure planner
`integration-passport-drift.ts`, and written by the weekly
`integration-passport-sweep` (Sunday 05:45 UTC). Nine rules, each one careless
edit from being undone:

- **Stored rows only, one decrypt, kind only.** The builder never calls the
  server. Each connection's secret is decrypted once, handed to
  `resolveMcpCredentials`, and only the grant KIND leaves; one that does not
  decrypt is `invalid`. Every row type declares the complete set of fields the
  builder may read, and the load `select`s name nothing else — a parameter
  set's values and a pin's text are excluded by not being selected. Timestamps
  are ISO strings before the digest (`canonicalJson` writes a `Date` as `{}`).
- **There is no passport table, and the prior is the EMITTED artefact.** Last
  week's passports are the newest `INTEGRATION_PASSPORTS` artefact strictly
  before this ISO week, read out of `Evidence.content` and verified against
  `AgenticEvidenceArtefact.sourceDigest`, which has no route writer. A prior
  that fails is `PASSPORT_PRIOR_UNVERIFIABLE` (HIGH), never a silent baseline.
  "Strictly before" is what makes a re-run in the same week idempotent; do not
  compare against "latest, this week included".
- **Events only in the transaction that emits.** Event findings carry the ISO
  week in their `sourceRef` (`…@2026-W42`) and are written only by a pass that
  also emits the passport they were found against, in the same transaction. A
  pass that raised events without emitting would leave the same prior and raise
  them again next week under next week's key. State findings carry no week,
  reopen when the condition returns, and close only on positive evidence.
- **No accountable owner means the OWNER role, with no assignee — and the
  assignee follows the owner while a finding is open.** P11 is
  `IntegrationConnection.ownerUserId`, set only by `setIntegrationConnectionOwner`
  (its own `admin.manage` route — never the connection upsert, whose
  `isEnabled ?? true` would re-enable a disabled connection). An owner without an
  ACTIVE membership is no owner. Every sweep moves each open finding about a
  connection to its current accountable owner (`intendedAssignee`), rewriting
  only the description's ownership TAIL (`reassignedDescription`) — so a
  connection finding's description must END with its ownership sentence. A
  create-only reconcile left the first Sunday's findings, all raised while the
  new column was empty, unassigned for good.
- **Never silent.** A tenant whose passports were not emitted gets
  `PASSPORT_NOT_EVIDENCED` with its reason; a truncated read (any source at its
  cap) compares, emits and closes nothing but still raises the state findings
  of the rows it read — each is a condition observed on a row, true whatever
  lies past the cap; every tenant ends in a counted outcome on
  `agentic.integration_passport.sweep`.
- **A passport is read by every evidence reader, so P1 is never the URL.** The
  emitted Evidence is `assertCanRead` and can travel in an audit pack's share
  link. A
  URL's path or query can carry a credential, so the endpoint is its origin plus
  `keyedChangeDigest` of the whole URL (HMAC under the deployment key, computed
  in the usecase because the builder is pure). Never put `configJson.url`, or
  anything else that is a secret in other hands, into the bundle or a finding.
- **`asOf` names a week; the rows are read now.** The job refuses a week that
  has not begun, and the pass refuses (`409`, under the lock) a week earlier
  than one the tenant already holds passports for — rebuilt from today's rows
  it would rewrite that week's evidence and raise later changes again under its
  key.
- **The shared emitter resolves ISO codes through `requirementCodeSpellings`,
  and judges withdrawal per KIND (`installedKinds`).** One flag across all kinds
  would let a tenant with only ISO targets withdraw every receipt artefact on a
  capped catalogue read that missed its ASI rows.
- **Audit after commit, under a namespaced lock.** `logEvent` appends in a
  transaction of its own under `hashtext(tenantId)`; the sweep's write
  transaction holds `integration-passport:<tenantId>` and queues its audit rows
  until it commits.

The view (`GET admin/integration-passport/{id}`) is `admin.tenant_lifecycle` and
a SIBLING of `admin/integrations/` — first-match-wins resolves that prefix to
`admin.manage`. The gate is a PLACEMENT beside the OWNER-only surfaces that
change the rung and pairings, not a confidentiality boundary: the same passport
is the week's Evidence, which every evidence reader can open. Do not cite the
gate as the reason a field is safe to put in a passport.

**The owner-orphan pass** (`usecases/agent-owner-orphan-pass.ts`, step 2b,
#3670) stops the ACTIVE agents whose owner has left, at 05:15 UTC. Five rules in
it are easy to undo:

- **An OWNER_DEPARTED kill is identified by `AgentKillSwitch.reasonCode`, never
  by the `reason` text.** A person types the text at the engage route; the code
  is written only by `engageOwnerDepartedKill`, which refuses any context but
  the system principal at actor type JOB, and a CHECK pins the code to
  `engagedByUserId = system:agent-owner-orphan-pass` on an AGENT-scope row.
  Reports and the lift rule read `isOwnerDepartedKill`, which reads the code. Do
  not add a second way to set it.
- **The lift needs a COMPLETED transfer after the kill, and the new owner.**
  `liftKillSwitch` refuses first; the `agent_kill_switch_reason_code_guard`
  trigger refuses the same lift for any writer, and refuses changing the code. A
  PENDING transfer is not a completed one, and the kill-switch key alone is not
  enough.
- **The mode is on the identity ladder**, read through `coerceStoredMode` at the
  boundary (`getAgentOrphanPassPolicy`), with the identity policy's
  `DRY_RUN_MIN_DAYS` / `DRY_RUN_MIN_PASSES`. The pass is not a third
  `IdentityDirection` — that union is closed on purpose — so its refusal
  sentences are its own and its rules are the ladder's.
- **Every refusal writes a row, unlike the leaver.** `MODE_DISABLED`,
  `MODE_ABOVE_CLAMP` and `NO_ACTIVE_AGENTS` are NOT_APPLICABLE rows naming the
  reason, and a throw is an ERROR row. `ORPHAN_PASS_MAX_MODE` sits at AUTOMATIC
  as the brake, so `MODE_ABOVE_CLAMP` is reachable only by narrowing it.
- **The HR signal is exact `emailKey` equality with exactly ONE employee.** Two
  employees on one key is `HR_MATCH_AMBIGUOUS`, never a pick, and a name never
  matches. An ABSENT membership row is a departure, because `removeTenantMember`
  deletes the row rather than writing REMOVED.

**The service-principal disable** (step 2c, #3671). When the orphan pass
contains an agent at AUTOMATIC, it REQUESTS that the agent's Entra service
principal be disabled (`usecases/agent-service-principal-disable.ts`), and the
request goes through the external write ladder and nowhere else. Rules that are
each one careless edit from being undone:

- **The disable lives on the OUTBOUND endpoint `/api/mcp/entra-service-principal`,
  a sibling of the grant endpoint, never in `src/lib/mcp/`.** One file speaks
  Graph's `servicePrincipals/` resource (`providers/entra-id/service-principal.ts`),
  one module imports it (`entra-service-principal-dispatch.ts`), and only the
  route imports that. `tests/guards/service-principal-disable-graph-seam.test.ts`
  holds that import graph, and also holds that `external-write-dispatch.ts` is the
  only module that calls `callTool` with a row's advertised write tool. Do not
  give a job a direct call "to save a hop": the hop is where the rung, the
  pairing and the journal are.
- **It has its own connection, so it has its own rung.** Do not move the two tools
  onto the grant endpoint: the rung is per connection, and a tenant at AUTOMATIC
  for grants would be at AUTOMATIC for disables. `endpointBindingRefusal` refuses
  a token whose connection is configured for a different endpoint.
- **The request opens rows and sends nothing.** DISABLED reads nothing; DRY_RUN
  `recordIntent`; PROPOSE_ONLY `createAgentProposal` (EXTERNAL_WRITE, prior state
  in the payload, `agentId` null); AUTOMATIC `openAutomaticExternalWrite` under
  the one approved template whose only open field is `servicePrincipalId`, bounded
  to `contained_orphan_agent_entra_service_principals`. No pairing, an unreadable
  prior state, or a read answering about another principal REFUSES. It never
  throws at the pass.
- **"Contained" is an `OWNER_DEPARTED` kill in force, and the link is the harness
  reconciliation.** `DiscoveredAgent.discoveredId = entra:sp:<GUID>` with
  `registeredAgentId` = the agent, exactly one per agent; two is `AMBIGUOUS_LINK`
  and is excluded from the population. The request and the population read both
  through `readContainedAgentServicePrincipalLinks`, so they cannot disagree. A
  completed transfer lifts the kill, and `SEND_PRECONDITIONS` in the dispatch
  refuses the disable at send at EVERY rung — a PROPOSE_ONLY approval made before
  the transfer must not leave after it.
- **At AUTOMATIC a PERSON must have confirmed the link** (owner decision,
  2026-10-18). `AgentServicePrincipalConfirmation`, written ONLY by
  `usecases/agent-service-principal-confirmation.ts` behind
  `POST /api/t/:slug/admin/agents/:agentId/service-principal-link` — a literal
  `requirePermission('admin.agent_registry')`, usecase floor
  `assertAgentGovernanceWrite(ctx, 'agent_registry')`; no API-key scope, `*`
  included, reaches that key. An unconfirmed link refuses `LINK_UNCONFIRMED` at
  request (the pass reports PARTIAL) and again at send for an AUTOMATIC row
  (`SEND_PRECONDITIONS`). DRY_RUN and PROPOSE_ONLY may act on the scanner's link,
  but the proposal's rationale must say THE LINK IS UNCONFIRMED — do not drop that
  sentence, it is the only place the approving human learns it. The confirm
  CONFIRMS the scanner's link and never makes one: it refuses unless the harness
  currently links that principal to that agent and the agent to it alone.
- **A confirmation is one-way and is invalidated, never re-pointed or revived.**
  A trigger (`agent_sp_confirmation_one_way`) refuses any rewrite of the triple,
  the confirmer or the times, and any change to an invalidation; `app_user` has no
  DELETE. The harness ingest, in its own transaction, stamps `PRINCIPAL_RELINKED`
  / `AGENT_RELINKED` when a scan moves the link, and a scan moving it BACK revives
  nothing. Readers also match the triple against the link as it stands
  (`liveConfirmationFor`), so a stale row still cannot vouch for another link.
- **The Graph permission is `Application.ReadWrite.OwnedBy` +
  `Application.Read.All`** (owner decision, 2026-10-18), never
  `Application.ReadWrite.All`. A principal Inflect's app does not own reads fine
  and then fails the PATCH 403 `Authorization_RequestDenied`; that throws, and the
  row settles INDETERMINATE for a human. Do not catch the 403 into a refusal —
  the dispatch cannot tell it from a request that reached the directory.
- **No blast-radius breaker** — decision 17 stands, re-confirmed by the owner for
  this write on 2026-10-18: `AUTOMATIC_WRITES_PER_CONNECTION_PER_WINDOW` (50 per
  connection per hour) bounds a mass departure.
- **ACCEPTED, never APPLIED on a 2xx.** The disable is in `ASYNC_DELIVERY_TOOLS`,
  and only the reconcile's verifier promotes it: the prior state read enabled, the
  current read says `accountEnabled: false`, same principal. An absent
  `accountEnabled` is unreadable, never false. An `isError` answer to any write
  settles INDETERMINATE, not ACCEPTED or FAILED.
- **The endpoint refuses the connection's own principal and Microsoft first-party
  principals**, and reads no JML direction flag: `writesEnabled` is consent to
  disable people's accounts, not an agent's principal.
- **The execution row names the `DiscoveredAgent` id, never the object id.**
  `resultJson` is not encrypted; the object id stays in the encrypted journal.

**Credential hygiene** (`usecases/agent-credential-hygiene.ts`, #3670, 06:00
UTC) writes FINDINGS ONLY — no credential row is touched, and its integration
test compares every key and connection row byte for byte. It reads one secret
per `mcp-server` connection to classify the grant through
`resolveMcpCredentials` and keeps only the kind. A finding closes only on
positive evidence from a complete read; a connection whose secret will not
decrypt is HELD. The rotation age is the tenant's
`TenantSecuritySettings.apiKeyRotationDays` (7..730, a DB CHECK; set through
`PUT admin/security-settings`, `admin.manage`, #3708) and
`DEFAULT_KEY_ROTATION_DAYS` (90) when that is NULL; `resolveRotationAge` decides,
and every row and finding names the days applied and their source
(`TENANT_SETTING` / `DEFAULT_NO_TENANT_SETTING`). A stored 90 is a tenant's
CHOICE and reports as such, so "use the default" is written as NULL, never as 90.
**Its key population is
AGENT credentials** — a key bound to an agent, or one the `/api/mcp` gate admits
(`admitsMcpEndpoint` in `lib/mcp/endpoint-scope.ts`, the gate's own predicate,
which `mcp/auth.ts` calls at both its sites). An integration key is not hygiene's
subject: the schema says binding every key to an agent "would make the register
a lie", so "bound to no agent" on a CI key is a finding nobody can act on. Do not
give the hygiene pass a scope list of its own; a scope added to the gate must
widen the population in the same diff.

**The built-in `AI_ADMIN` role, since 2a (#3699, two deploys).** It runs the
agent register and can own and receive agents, holding the agent keys and no
tenant-wide admin key (see the Epic 1 "Role model" paragraph for its
`PermissionSet`). Rules that are each one careless edit from being undone:

- **The edge admits it to `AI_ADMIN_ADMIN_PATH_PREFIXES` and nowhere else
  under `/admin`** (`src/lib/auth/guard.ts`): `/api/t/:slug/admin/agents`,
  `/api/t/:slug/admin/mcp/quarantine` (the one agent-key API outside it) and
  the three agent redirect pages still under `/t/:slug/admin`. Matching is on
  segment boundaries, never a bare `startsWith`, and a non-canonical path (a
  `%`, a backslash, an empty or dot segment) is refused rather than reasoned
  about. `tests/unit/ai-admin-edge-allowlist.test.ts` pins the list by exact
  set equality and runs the real middleware for an AI_ADMIN over every admin
  API route on disk; `tests/unit/ai-admin-handler-authz.test.ts` proves the
  handler refuses it everywhere else too. Widening the list is a
  security-middleware change: name the key the new path's handler takes and
  show the role holds it.
- **Two writers, and no third.** Deploy 1 shipped the value read-only (a
  container whose Prisma client predates it fails every read of a row carrying
  it); deploy 2 added the members-page role change (OWNER-only in both
  directions) and Entra group mappings (`ENTRA_MAPPABLE_ROLES`, and
  `SCIM_GROUP_ASSIGNABLE_ROLES` for the Groups push — SCIM's Users ceiling
  `SCIM_ASSIGNABLE_ROLES` still excludes it). Do NOT append it to
  `ASSIGNABLE_TENANT_ROLES`: that list is shared by invites, the direct add, an
  access review's MODIFY and their redemption/close paths, and none of them may
  write it. `tests/unit/ai-admin-role-writers.test.ts` pins the `WRITERS`, the
  exact consumers of each widened list, and one refusal per other writer.
- **No custom role on an `AI_ADMIN` membership** (`mayCarryCustomRole`). A
  custom role's base REPLACES the built-in role at resolution, so both orders
  are refused (`ConflictError`, reason `BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`),
  never repaired — on the members page, in `assignCustomRole` and by the group
  sync (`custom_role_held`).
- **A priority tie with ADMIN, EDITOR or AUDITOR decides nothing.** Group-role
  resolution breaks ties by seniority, but `AI_ADMIN` is off that ladder
  (`TIE_DECIDABLE_AGAINST`): it beats READER, which it contains, and against
  the others the resolver yields no role, so the membership keeps its own
  (`ambiguous_tie`). The admin settles it with `priority`.
- **Its coarse tier is READER's, on purpose.** `ROLE_ORDER.AI_ADMIN` is 1, so it
  passes no usecase gated on `canWrite`/`canAdmin` alone. The agent usecases
  take `assertAgentGovernanceWrite` / `assertAgentGovernanceAdmin` instead of
  `assertCanWrite` / `assertCanAdmin`: the coarse tier OR the agent key the
  route requires. Do not "simplify" that back, and do not raise the rung to make
  a refusal go away — a higher rung would admit it to most of the product's
  writes.
- **It is the enum's LAST value.** Three job actor pickers order
  `TenantMembership.role` ascending to find the most senior member; an AI_ADMIN
  must never sort ahead of ADMIN. The migration is a plain `ADD VALUE`.

### Claude agent engines

An agent builder that lets a customer set up their own agent with no CLI, and
the engines that run what it builds: the Tool Runner first, the Agent SDK if a
profile ever needs it, and Managed Agents for profiles that need a container.
**The three design documents are the source of truth for intent**:
`docs/claude-agent-sdk-design.md` (the builder, Phases 0, 1, 3 and 4, and the
global rules every step obeys), `docs/claude-tool-runner-design.md` (Phase 2)
and `docs/claude-managed-agents-design.md` (Phases 5 and 6). The work is the
step issues under #4135, one pull request each.

Three of the global rules, because they are the ones a careless edit undoes:

- **The engine decides what to try; the funnel decides what is permitted.**
  Every tool call any engine makes goes through `runGuardedTool` →
  `runReadTool` / `runProposeTool`. An engine module holds no permission check,
  no usecase call and no Prisma call.
- **Authority only narrows.** A profile's tools are a subset of the agent's
  grants, instructions teach and never grant, and nothing a tenant writes can
  widen a grant, a ceiling or a scope.
- **Nothing new is stored at Anthropic without the sub-processor step.** The
  hosted engines send Messages API calls only (`thread: false`,
  `persistSession: false`); Managed Agents stores data by design and is gated in
  its own phases.

**The tool core is engine-neutral** (`src/lib/agentic/engine-tools/`, Step 0a).
The scope / autonomy / read-only narrowing (`offerToolSet`), the review latch and
the guarded call live there, and `eslint.config.mjs` refuses any import of
`@flue/*`, `valibot` or `@earendil-works/*` under it. An engine supplies only its
tool shape (a `ToolBuilder`) and its guard source prefix; `runGuardedTool` takes
the prefix with no default, so a new engine names its own audit rows. Flue's
prefix is `'flue'`, which keeps every guard source byte-identical to what it was
before the move.

**Every model call is preceded by the kill switch and the caps** (#4196). A kill
engaged mid-run used to refuse only the tool calls: the model was called again
and the run settled COMPLETED. On Flue the interceptor in `flue/telemetry.ts`
awaits the run binding's `beforeModelCall` once per model operation, keyed on
the operation object, because the runtime intercepts every streamed chunk of
one call with the same object. Do not move the check to the tool boundary or
the agent render: the tool boundary is too late, and the render cannot await.

**"Is this a reasoning engine" is `isReasoningEngine(driver)`**
(`src/lib/agentic/agent-driver.ts`), never a comparison with `'flue'`. It is
backed by a `Record<AgentDriver, boolean>`, so a driver added to `AGENT_DRIVERS`
without a classification fails `tsc`. The registration gate, the skill pin and
the worker hand-off in `startWorkflowRun` and `resumeWorkflowRun` ask it, so the
next engine is vouched, pinned and kept off the web tier without anybody
remembering those lines. A comparison that genuinely means Flue (the
`FLUE`/`STATIC` run label, the Flue-specific gate in `agent-driver-policy.ts`)
stays a comparison.

**The engine choice has one control: the "Agent engines" section on Admin → AI
features** (Step 0c, #4181; two owner decisions of 2026-10-25 on #4139).
`GET /admin/agent-driver` is `admin.view`, so every admin reads the gate, and
the `PUT` stays `admin.tenant_lifecycle`. The page gates each section, not the
whole page. The six-term `flue-wiring` checklist stays OWNER-only. The section
requests it only for a viewer who can change the engine, so an admin's visit
writes no `AUTHZ_DENIED` row. Do not put a second engine control anywhere
else: the Flue card on Integrations was that, and it was removed. A new engine
is offered by adding its mode to `AGENT_DRIVER_MODES` and its name and
description to `admin.agentEngines.engine`. A new `StaticDriverReason` must get
a sentence in `REASON_MESSAGE`, which `satisfies` the union, so `tsc` fails
until it does.

**A new engine passes the driver conformance suite before it is switched on**
(Step 0b, `tests/helpers/driver-conformance.ts`). Two engine-agnostic tables
hold ten run scenarios and one admission scenario. An engine supplies an
adapter, which scripts the model's turns and reads back an observation. The
scenarios assert only on that observation. The helper reads `adapter.engine`
for two describe titles and nothing else, and
`tests/unit/driver-conformance-variances.test.ts` counts the reads. Do not add
an engine branch to the helper. A difference belongs in the adapter, or in a
VARIANCE that names the stronger property and the owner decision accepting it
(`checkVariances`, which runs as a case of its own). Flue declares none.

Two scenarios are easy to weaken by accident:

- **The kill scenario** holds every engine to the per-model-call check above.
- **The ledger scenario** is `ledger-accounts-for-every-call`. A `MODEL_CALL`
  step may cover a dispatch if it names how many calls it covers (owner
  decision 2026-10-25, #4197). The count is asserted against the model inputs
  and is never inferred from the number of steps.

## Testing Conventions

- **Unit tests**: Mock dependencies with `jest.mock()` declared **before** imports. Use the `makeRequestContext(role, overrides)` helper from `tests/helpers/make-context.ts` to construct test contexts.
- **Integration tests**: Use `prismaTestClient()` and `resetDatabase()` from `tests/helpers/db.ts`. Hit a real DB — do not mock Prisma in integration tests.
- **Guard tests** (`tests/guards/`): Static analysis tests that enforce architectural rules (no `as any`, no unsafe patterns). These are regular Jest tests that scan source files with regex.
- **A source scan's population comes from git.** Use `repoFiles()` /
  `repoRelativeFiles()` from `tests/helpers/repo-files.ts` — backed by
  `git ls-files --cached --others --exclude-standard` — rather than an
  `fs.readdirSync` walk with a `['node_modules', '.next']` skip list. Such a
  list is a hand-maintained denominator and nothing checks it against reality:
  it had never heard of `.claude/`, where `.claude/worktrees/<id>/` holds a FULL
  checkout of the repo, so the prisma-schema guardrail read its own copy of
  itself and reported it — green on CI, red only for whoever used worktrees.
  `tests/guardrails/source-scan-population.test.ts` fails CI on any file under
  `tests/` that hands the repo root to a directory read, and carries no
  allowlist. See
  `docs/implementation-notes/2026-08-21-source-scan-population-from-git.md`.
- **E2E tests**: Playwright fully parallel (`fullyParallel: true`,
  2 workers in CI, auto locally — see
  `docs/implementation-notes/2026-06-23-e2e-parallelization.md`).
  **Structural isolation, not shared state** (`chore/e2e-isolation`):
    - **Read-only specs** (list pages, filters, a11y, theme, tooltips,
      responsive, display checks — navigate + assert, never
      create/edit/delete) keep the SHARED seeded tenant via
      `loginAndGetTenant(page)` / `DEFAULT_USER`. They need the seed
      data and read-only access cannot cascade.
    - **Mutating specs** (anything that creates/edits/deletes) import
      `{ test, expect }` from `./fixtures` and declare the
      `isolatedTenant` / `authedPage` fixture. Each `test()` gets its
      own fresh, EMPTY tenant via `createIsolatedTenant` — writes can
      never touch the shared tenant or another test. An isolated
      tenant starts empty: the spec creates the resources it needs in
      its own body or a `beforeEach`.
    - **No cross-test `let` cascade.** A `let`/`var` assigned inside
      one `test()` and read by another is banned — a failed setup
      step would cascade. Make each test self-contained, or collapse
      a true sequence into ONE `test()` with `test.step(...)`
      sub-steps. Assigning a top-level `let` in a `beforeEach` /
      `beforeAll` is fine. Enforced by
      `tests/guards/e2e-isolation.test.ts`.
    - **Selectors: prefer a role or an existing HTML `id`; reach for
      `data-testid` only where neither exists.** In hand-written
      markup, do not sprinkle `data-testid` on an element merely to
      select it — give it a real `id`, or select it by role/label.
      Measured practice in `tests/e2e` spec files: `#id` locators 304
      calls, `[data-testid=…]` 101, `getByRole` 85;
      `getByTestId` is used **zero** times.
    - **`<DataTable>` is the documented exception, because there its
      `data-testid` prop IS the `id` setter.** `DataTableProps` has no
      `id` prop and does not extend `HTMLAttributes`; every render
      branch emits `<div id={dataTestId} data-testid={dataTestId}>`.
      So passing `data-testid="risks-table"` is *how* you create the
      "existing HTML `id`" (`#risks-table`) the rule above tells specs
      to select on — it is not an extra attribute bolted on for tests.
      Omitting it leaves the table addressable by neither. Ten `#id`
      selectors across 34 E2E locator calls (`#controls-table`,
      `#members-table`, `#evidence-table`, `#soa-table`, the
      `#linked-*-table`s and the `#org-*-table`s) exist
      only because that prop was passed. Every list page must pass it,
      on the `<DataTable>` itself or in the `table={{ … }}` config of
      `EntityListPage`; `tests/unit/data-table.test.ts` enforces it and
      `src/components/ui/table/GUIDE.md` shows the canonical call.
    - **Rendered (RTL) tests are testid-first** — `tests/rendered`
      calls `getByTestId` 806 times across 124 files (1,087 `*ByTestId`
      queries across 130 files). A `data-testid`
      added because a rendered test needs a stable handle is correct
      and is not covered by the preference above.
    - Scope `#id` / role locators to `getByRole('main')` where a
      Next streaming duplicate of the page could match — never a
      bare page-level locator (see the risk-matrix E2E lesson).
  See `docs/implementation-notes/2026-05-21-e2e-isolation.md` and
  `tests/e2e/fixtures.ts`.
- `SKIP_ENV_VALIDATION=1` is set in `jest.setup.js` to prevent env loader crash in unit tests.
- Coverage floors live in `jest.thresholds.json` (five keys: `global` +
  `usecases/` / `policies/` / `events/` / `lib/`), with the reasoning in
  `docs/coverage-policy.md`. A path key REMOVES its files from `global`,
  so `global` means "the declared scope minus those four folders", not
  "everything". `npm run test:coverage` reports but does not gate —
  enforcement is `scripts/check-merged-coverage.ts` in the
  `Coverage (≥60%)` CI job, which **runs on pull requests** (since
  2026-08-25 — it was `push`/`schedule`/`dispatch`-only while a separate
  `Coverage (shard N/4)` matrix re-ran the whole suite to instrument it).

  It now merges **six** artifacts, and which six is load-bearing.
  Coverage is collected by the jobs that already run the suite: the four
  `Test` shards (`JEST_SKIP_RATCHETS=1`, 1392 files), `Ratchets`
  (guards + guardrails + contracts, 661 files) and `Flue`
  (`coverage-shard-flue`). Those sets are
  disjoint and exhaustive — together they are the whole suite, which is
  what makes the merged numbers comparable to the old single-matrix ones.
  **Read the count off `ci.yml`, never off this paragraph:** the trailing
  argument to `scripts/check-merged-coverage.ts` is the authority, the
  guard derives its own expectation from the workflow rather than a
  literal, and this sentence said *five* for as long as flue existed —
  the one number here that nothing makes follow its source.
  Since a path key removes its files from `global`, changing WHICH tests
  contribute changes what every floor means with no number in the diff,
  so `tests/guardrails/coverage-gate-population.test.ts` pins the
  partition, the `--coverage` flag on each job, the uploads, and the
  expected-artifact count. If you add a Jest job to `ci.yml`, it collects
  coverage and uploads a `coverage-shard-*` artifact, or that guard fails.

### Index & query-shape guardrails

Two structural guardrails enforce database-performance hygiene. Both
read the LIVE Prisma schema / `src/app-layer` source — no DB, no
migration-file coupling. The structured schema parser they stand on
is `tests/helpers/prisma-schema-models.ts` (`parseSchemaModels()`).

- `tests/guardrails/schema-index-coverage.test.ts` — four index
  layers. **A** (auto): every model with a `tenantId` field must have
  a `tenantId`-leading `@@index`/`@@unique`/`@@id`. **B** (auto):
  every foreign-key scalar field must be indexed — leading an index,
  or (on a tenant model) the 2nd column of a `[tenantId, fk]`
  composite. **C**
  (curated): `LIST_QUERY_INDEXES` — composite indexes backing
  specific list filter+sort shapes. **C-completeness** (auto): every
  tenant-scoped model that is `findMany`'d in `src/app-layer` must be
  in `LIST_QUERY_INDEXES` or `LIST_MODELS_TENANT_INDEX_SUFFICIENT`.

- `tests/guardrails/query-shape-guardrails.test.ts` — two query
  layers. **D1**: no Prisma READ call inside a loop (N+1).
  **D2**: a one-way-down budget on unbounded (`take:`-less)
  repository `findMany` calls.

**When you add a model:** Layers A/B/C-completeness fire
automatically. If the model has a `tenantId`, add a
`@@index([tenantId])` (or a tenantId-leading composite). Index every
FK column (a `[tenantId, fk]` composite counts) or expect Layer B to
flag it. The first `findMany` on the
model forces a Layer C-completeness triage — add it to
`LIST_QUERY_INDEXES` (with a real composite index) or to
`LIST_MODELS_TENANT_INDEX_SUFFICIENT` (with a written reason).

**When you add a `findMany`:** keep it bounded with `take:`. An
unbounded repository `findMany` must either add `take:` or carry
`// guardrail-allow: unbounded` with a reason. A read inside a loop
trips D1 — hoist it to one `findMany({ where: { id: { in: [...] } } })`
plus an in-memory map, or (for an intentional bounded-loop
idempotency check) add `// guardrail-allow: n+1` or a
`KNOWN_N_PLUS_ONE` entry with a reason.

All exempt/baseline maps carry a written reason per entry and a
"no stale entries" test — when a real index lands or an N+1 is
fixed, delete the entry in the same diff.

### Codebase-hygiene ratchets

Three codebase-hygiene invariants are held by structural guardrails
— **see `docs/codebase-hygiene.md`** for the contributor guide:

- **`as any` stays on a downward ratchet.** The `src/` count is 0
  (the staged debt has been fully eliminated). `tests/guardrails/no-explicit-any-ratchet.test.ts`
  caps it via `CURRENT_BASELINE` with a drift sentinel (slack cannot
  accumulate); `tests/guards/no-explicit-any-ratchet.test.ts` caps
  `: any` / `<any>` / `as any` / `@ts-ignore`. Removing casts ⇒
  lower the baseline/caps in the same PR. `@typescript-eslint/no-explicit-any`
  is `warn` repo-wide (a large `: any` debt makes `error` infeasible)
  — the ratchet is the enforcement — except on the security
  perimeter: `eslint.config.mjs` overrides it to `error` for
  `src/lib/security/**/*` and `src/middleware.ts`.
- **Logging discipline applies to adapted code too.** No `console.*`
  in server code (`tests/guardrails/logging-import-hygiene.test.ts`).
  The vendored `src/lib/dub-utils/` tree that once held a blanket
  exemption was deleted on 2026-06-04 (#829, de-Dub); the guardrail
  still asserts no `lib/dub-utils/` prefix can return to the
  allowlist. Today's allowlist is `lib/observability/edge-logger.ts`,
  `lib/api-client.ts`, `instrumentation.ts`, plus four
  `components/ui/` client-component prefixes.
- **Route handlers type `params` as `Promise<…>`.** Next 15+
  contract; `tests/guards/async-params-route-typing.test.ts` blocks
  a regression. The old transparent-await shim is retired.

`tests/guards/codebase-hygiene-integrity.test.ts` is the meta-ratchet
over these four guardrails.

### Assertion-reach ratchets (#2246)

Two downward ratchets over the TEST suite itself, both standing on
`tests/helpers/assertion-reach.ts` — an AST walk (`ts.createSourceFile`,
syntax only) over every `.ts`/`.tsx` file **git** lists under `tests/`. They
police one sentence: *an assertion whose reach is not the thing it names.*

- **`tests/guardrails/assertion-span-reach-ratchet.test.ts` — Class C.**
  Counts `expect(x).toMatch(/…/)` regexes carrying an any-char span
  BETWEEN two pieces of pattern. Such a span re-forms across a **sibling**
  block, so deleting the thing under test leaves the assertion satisfied by a
  neighbour — proved twice, both times leaving the suite fully green.
  Three baselines, and the ratchet file is the authority for their values —
  `UNBOUNDED_INTERIOR_SPAN_BASELINE` (unbounded interior spans),
  `INTERIOR_SPAN_BASELINE` (interior spans of any boundedness; this second cap
  exists so rewriting `*?` as `{0,200}` cannot buy the first number down), and
  `UNANALYSABLE_TOMATCH_BASELINE`. They are in the low hundreds and they only
  ever go down.

  All seven spellings of "any character" count — `[\s\S]` / `[\S\s]` /
  `[\d\D]` / `[\D\d]` / `[\w\W]` / `[\W\w]` / `[^]`, plus `(?:.|\n)` and a
  quantified `.` under the `s` flag. Two shapes are deliberately NOT counted
  and are reported in their own buckets: a subject that is already a bounded
  extraction (`declarationOf(src, 'fetchVendor')` — the span cannot leave the
  extracted construct, and that site has the recommended fix applied), and a
  `not.toMatch`, where a wider span forbids MORE and so makes the assertion
  stronger. `toMatch('a literal')` is out of scope rather than un-analysable —
  it cannot carry a span, so writing one must not move the skip ceiling.

- **`tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` — Class D.**
  For every `toMatch`/`toContain` against a **whole-file read**, counts how
  many places in that file satisfy the needle. More than one and the named
  thing can be deleted while a survivor keeps the guard green — proved three
  times, one of them a `.toContain`, which is why both matchers are in scope.
  Three baselines, again authoritative in the ratchet file:
  `AMBIGUOUS_NEEDLE_BASELINE`, `HIGHLY_AMBIGUOUS_NEEDLE_BASELINE` (needles with
  five or more satisfying positions) and `UNANALYSABLE_READ_BASELINE`. Class D's
  are an order of magnitude larger than Class C's — over a thousand each for the
  two big ones.

  A whole-file read wearing a transform the analyser cannot follow
  (`codeOnly(readFileSync(…))`, `src.toLowerCase()`, `` `${schema}` ``) is
  `content-transformed` — a CAPPED skip. It used to be `not-a-file-read`,
  which is uncapped, so four such assertions could be added and every ceiling
  held. A NARROWED read (`declarationOf(src, name)`, `src.slice(…)`) stays out
  of scope, because narrowing is the fix and a guard that reddens when you
  take its advice is one people route around.

Three things about these that are easy to get wrong:

- **The denominator is part of the result.** Each ratchet caps its own
  SKIPPED count and floors its analysed share, because a detector that
  silently drops what it cannot parse reports full coverage of the subset it
  understands — the same defect one level up. Concretely: hiding a span
  behind `new RegExp(someVariable)` does not evade Class C, it turns the
  skip ceiling red instead.
- **`DRIFT_ALLOWANCE` is 0 in both**, unlike the older count ratchets. These
  numbers never move incidentally, so any allowance would be pure headroom
  for the next regression. Removing one of these means lowering the baseline
  by one in the same diff.
- **Read the constant, never a number quoted about it.** This section used to
  carry all six figures inline and every one of them had rotted — by 29, 29, 2,
  87, 19 and 118 — because each drain lowers a baseline and nothing makes prose
  follow. With `DRIFT_ALLOWANCE` at 0 that rot is not cosmetic: an author who
  trusts a stale, higher figure believes in headroom the ratchet will not grant.
  Same defect as the `counts` header this repo deleted from
  `doc-classification.json` — derived data stored beside its own source.
- **Class D can fire on a diff that touches no test.**
  `.toContain('model VendorEvidenceBundle')` was unambiguous until somebody
  added `VendorEvidenceBundleItem` to the same schema file. Being told is the
  point — which is why its failure message samples the population
  **ascending**: a site that has just crossed the threshold sits at exactly 2,
  and a descending sample lists twenty standing offenders the diff never
  touched.

The fix for a hit is never to add an exemption — there is no allowlist. Bind
the read to the construct (`declarationOf` / `functionBodyOf` /
`interfaceBodyOf` / `braceBlockAfter` / `callExpressionOf` / `codeOf` from
`tests/helpers/source-blocks.ts`) or narrow the needle until only the named
thing satisfies it. See
`docs/implementation-notes/2026-09-02-assertion-reach-ratchets.md`.

### Epic-ratchet lifecycle

Guard naming — **epic ratchets are retired when their epic ships**

A guard named for one PR or epic (`b7-…`, `item-27-…`, `r14-…`, `epic55-…`,
`pr-b-…`, `roadmap-11-…`) locks the **shape of one diff**, not an
architectural rule. It cannot catch a regression the type system would miss —
the code it guards is imported and type-checked at its real call sites — and
it fires on renames, class sorting, reformatting and helper extraction. Its
true-positive rate is structurally zero.

On 2026-08-05, **153 such files (~22,500 lines) were retired**, taking the
guard suite from 777 files to 624. The four that turned out to carry real
security invariants were **renamed**, not deleted (`evidence-download-authz`,
`evidence-review-authz`, `evidence-list-resilience`,
`risk-quantitative-analytics`) — the invariant was worth keeping; only the
name was wrong.

The rule is enforced by `tests/guards/no-epic-named-ratchets.test.ts`, whose
`ALLOWED` map lists the ten survivors with the reason each could not be
deleted. **Shrink that list; do not grow it.** When you need a new guard:

- Name it for the invariant it protects.
- If the rule is structural — a banned import, a required prop, a forbidden
  identifier, a naming convention — write an **ESLint rule** instead. An AST
  rule survives reformatting and renaming; a regex over source text does not.
  **`eslint-rules/` is where those live** — a local plugin registered as
  `local` in `eslint.config.mjs`, with one rule per file and a `RuleTester`
  test beside it. Read `eslint-rules/README.md` first: it carries the
  rule-vs-selector-vs-guard decision (a single esquery selector in
  `no-restricted-syntax` often says the whole thing and needs no rule file),
  and the module-format constraint — CommonJS `.js`, because `.mjs` cannot be
  required by Jest and `.cjs` breaks the Lint job's `react-hooks` plugin
  scope. See
  `docs/implementation-notes/2026-08-24-custom-eslint-rule-infrastructure.md`.

**Reconciling this with "ratchet every PR."** The two are not in conflict once
the word is read precisely. Ship each PR with a test that **fails when the
behaviour regresses** — a rendered test, a usecase test, a round trip. What is
retired is the reflex of pinning *the shape of the diff you just wrote*. If the
only test you can think of would pass while the feature is visibly broken, it
is not protecting the feature. The Assets status control is the worked example:
`tests/guards/item-29-status-buttons.test.ts` asserted the schema *mentions*
`status` and stayed green for months while the control persisted nothing.

**Never gate CI on prose.** A check that greps a markdown file for a filename
verifies *mention*, not accuracy — a row describing behaviour that has since
changed still passes. Worse, `tests/guards/rq3-11-capstone.test.ts` (deleted
2026-08-06) required every `rq3-*.test.ts` name to appear in the capstone, so
shipping an RQ3 follow-up turned CI red until a filename was pasted into
prose, and the cheapest way back to green was writing another ratchet. Doc-index
checks belong in `npm run docs:lint` — advisory, human-read, not a build gate.

**Bounding a source read.** When a guard must assert something about one
function inside a large file, use `declarationOf()` from
`tests/helpers/source-blocks.ts`. Never slice between two declaration *names*
(reordering yields a backwards slice — silently empty, so every `not.toMatch`
in it passes while checking nothing) and never slice a magic byte offset
(`indexOf(x) - 800`), which an unrelated edit upstream slides off the target.

The `rq*` family predates this rule and escaped the 2026-08-05 sweep because
`^rq` was missing from the pattern list. It is now a **downward ratchet** in
`no-epic-named-ratchets.test.ts`: the count of `/^rq\d/` guards must
equal `RQ_CEILING` exactly (35 today), so a new `rq<N>-` guard is
blocked and each retirement tranche lowers the ceiling in the same
diff. Note the filter needs the digit — `^rq` is still not in
`EPIC_NAME_PATTERNS`, so a name like
`rq-calibration-pd-recommendation.test.ts` slips past both checks.

See `docs/implementation-notes/2026-08-05-retire-epic-ratchets.md` and
`docs/implementation-notes/2026-08-06-retire-rq-epic-ratchets.md`.

## Failing tests

A failing test on a branch is a failing test, full stop. "Pre-existing on
main" is a diagnosis, not a license to bypass it. The rule:

- **Run the affected test suites before claiming a task is done.** Don't
  rely on "my changes only touch X" — Jest projects, structural ratchets,
  and import graphs catch surprising regressions.

- **When a test fails, find the root cause first.** Check whether your
  change broke it; if not, check whether it's failing on `main` too. The
  goal is to know what the failure means, not to assign blame.

- **Pre-existing failures must be fixed, not bypassed.** If a suite is
  red on `main`, that's a bug — open a focused fix PR, link it from the
  current PR, and either (a) include the fix in the current PR if it's
  small and on-scope, or (b) explicitly call out the blocker in the PR
  description. Never silently admin-merge through a red test.

- **Never use `gh pr merge --admin` to push past failing CI** without
  the user's explicit authorisation for that specific PR. Required
  checks exist for a reason; the cost of pausing is low, the cost of
  shipping a regression to main is high.

- **Apply the same standard to dependency PRs.** A dependabot bump that
  breaks a test on `main` still needs the underlying breakage fixed,
  even though the bump itself is mechanical.

The exception: if the user has explicitly said "merge despite the
failures, I know what they are" for a specific PR, that authorisation
stands for that PR only — not as a precedent.

## Key Conventions

- **Zod schemas** for all API input validation live in `src/app-layer/schemas/`
  and `src/lib/schemas/`. Both are backend-first but neither directory is
  client-free — 13 `'use client'` files import values from
  `@/app-layer/schemas/*` (`CALENDAR_EVENT_CATEGORIES` in `CalendarClient.tsx`,
  `ENTRA_MAPPABLE_ROLES` in `GroupMappingsSection.tsx`), and the five
  `src/lib/schemas/*-form.ts` files exist precisely to be imported by the
  `_form/useNew*Form.ts` client hooks. What IS backend-only is
  `src/lib/schemas/index.ts`: it is
  ~1,270 lines of pure API request bodies with ZERO client importers, so the
  long-standing "(shared)" label here was wrong. The split is benign — nothing
  is duplicated across the two — so this is a doc correction, not a refactor
  brief. See `docs/calendar-surface-do-not-touch.md` §5.
- **Task subsystem is named `Task`, never `WorkItem`.** The aggregate at
  `prisma/schema/tasks.prisma` has always been `Task` (+ `TaskLink`,
  `TaskComment`, `TaskWatcher`, `TaskKeySequence`), but a parallel
  `WorkItem*` vocabulary grew up around it in the enums, the status
  machine and the repository. `Task` wins on measured cost: the
  Task-side vocabulary is ~1,532 occurrences against ~155 for the five
  enums — a 10× difference, and renaming the *model* would also change
  every Prisma accessor (`db.task` → `db.workItem`) and the physical
  table name in the RLS policies.

  New code uses `Task*` for everything in this subsystem. The five
  enums were renamed on 2026-08-12 (`WorkItemStatus` → `TaskStatus`,
  and likewise Type / Severity / Priority / Source), joining the
  already-`Task*` `TaskLinkEntityType` / `TaskLinkRelation`.

  **The enums carry `@@map("WorkItem*")` and that pin is load-bearing.**
  It keeps the physical Postgres type names unchanged, so the rename
  emitted **no migration**. Do not "tidy" the `@@map` away: Prisma emits
  explicit enum casts (`$1::"WorkItemStatus"`) in generated SQL, so an
  `ALTER TYPE … RENAME` would make every still-running old container in
  a rolling deploy fail task reads with SQLSTATE 42704.
  `tests/integration/task-enum-db-mapping.test.ts` fails if either half
  of the pin breaks.

  The rename is now COMPLETE. `WorkItemRepository` became
  `TaskRepository` (the target filename was freed when its dead 5-line
  re-export was deleted), and `domain/work-item-status.ts` became
  `domain/task-status.ts` — `checkWorkItemTransition` →
  `checkTaskTransition`, `WorkItemStatusValue` → `TaskStatusValue`,
  `WORK_ITEM_TRANSITIONS` → `TASK_TRANSITIONS`, and the
  `*_WORK_ITEM_STATUSES` constants → `*_TASK_STATUSES`. There is no
  `WorkItem*` identifier left in `src/` or `tests/` — the surviving
  occurrences are the five `@@map` pins above, string literals inside the
  two guards that assert them (`tests/integration/task-enum-db-mapping.test.ts`,
  `tests/unit/task-repository-seam.test.ts`), and prose in historical
  implementation notes.

  `tests/unit/task-repository-seam.test.ts` refuses a re-introduced
  `WorkItemRepository` export and, more generally, any two exported
  classes in the repositories layer that share one object identity —
  so a compatibility shim cannot quietly restore the two-names state.
  The `Issue*` re-exports in `IssueRepository.ts` are the one remaining
  alias set, listed there as a downward ratchet.
- **Audit trail**: Call `logEvent()` from `src/app-layer/events/audit.ts` after mutating state. Entries are hash-chained — never write directly to the `AuditLog` table.
- **Error classes**: Use typed errors from `src/lib/errors/` rather than throwing raw `Error`.
- **i18n**: UI strings go through `next-intl`. Message files are in `messages/`. Server components use `getTranslations()`, client components use `useTranslations()`.
- **Path alias**: `@/` maps to `src/`. Always use this alias — never relative paths crossing layer boundaries.
- **Three DB connection vars**: `DATABASE_URL` points to PgBouncer (transaction-mode, used at runtime). `DIRECT_DATABASE_URL` points directly to Postgres (used for Prisma migrations). `DATABASE_READ_URL` is the optional read-replica string — when set, replica-tolerant reads route through `prismaRead` / `runInTenantReadContext`; unset means single-DB mode and `prismaRead === prisma`. See `docs/database-routing.md`.
- **Page-section rhythm** (Roadmap-5 PR-9): the spacing scale
  (`tight` / `compact` / `default` / `section` / `page`) is rich, but
  vertical page rhythm wants only TWO answers most of the time.
    - **`space-y-section`** — between top-level page regions (page
      header, filter toolbar, primary table, footer toast). The
      24-32 px breath that says "this is a different kind of thing".
    - **`space-y-default`** — inside a card, between sibling fields,
      between rows in a panel. The 16 px breath that says "same kind
      of thing, next instance".
  Use `space-y-tight` / `space-y-compact` only inside dense field
  groups where the children are micro-elements (icon + label, status
  pills). The semantic-scale ratchet at
  `tests/guards/spacing-scale-discipline.test.ts` already bans raw
  numerics; this convention guides the choice between `default` and
  `section`.
- **Border tone discipline** (Roadmap-5 PR-10): three semantic
  border tones, each with a clear role.
    - **`border-border-subtle`** — DEFAULT. Structural separators
      (form-field outlines, table-cell separators, quiet panel
      boundaries, sidebar item dividers). If you have to ask
      "default or subtle?", the answer is subtle.
    - **`border-border-default`** — Reserved for surfaces that need
      explicit containment: card outer border, table outer border,
      modal/sheet boundary, popover/tooltip outline. The "this is a
      discrete surface" statement.
    - **`border-border-emphasis`** — Reserved for state: selected
      card, active panel, focused field, hovered click target. Tone
      that says "this is the one you mean".
  Forward enforcement at `tests/guards/border-tone-budget.test.ts`
  (budget ratchet that locks the current count and only ratchets
  down).
- **Action button vocabulary** (revised 2026-05-28). The label on a
  primary "create" header button is JUST the entity noun. The `+`
  glyph rides the `icon` slot — never as text. So an entity list page's
  header trigger reads:

  ```tsx
  <Button variant="primary" icon={<Plus />} onClick={…}>Risk</Button>
  ```

  not `+ Risk` (in text) and not `Create Risk` / `New Risk` / `Add Risk`
  (verb-prefixed). The verb is dead weight once the Plus glyph is doing
  the work, and the Button primitive is `justify-center` and hugs its
  content, so the whole `[icon][gap][label]` unit centres as one symmetric
  group (`src/components/ui/button.tsx` — the old icon-balance ghost was
  reverted 2026-05-31).

  Caveats — where verbs still belong:
    - **Modal/dialog confirm buttons** keep their verbed form
      (`Create risk`, `Add document`, `Save policy`) — confirmation
      surfaces need to declare the action, not just the subject.
    - **Detail-page "+ child entity" affordances** that attach to an
      open parent ("Add Document" on vendor detail, "Add Comment" on
      a task) follow this same icon-slot rule, but if you keep a verb
      it's `Add {Entity}` (the child-attachment register).
    - **Traceability / cross-entity association** uses
      `Link {Entity}` (`Link Risk`, `Link Control`) — the verb
      changes the meaning (associating, not creating).

  Forward enforcement:
    - `tests/guards/action-label-vocabulary.test.ts` — bans literal
      `+ Word` text in JSX/source.
    - `tests/guards/action-button-canonical-entity-label.test.ts` —
      asserts the canonical entity-page header buttons render
      `icon={<Plus />}` + bare noun, AND that the header-action
      i18n keys (`addAsset`, `addRisk`, `addEvidence`, `newAudit`,
      `newFinding`) hold just the noun, not a verb-prefixed string.
- **Destructive-action vocabulary** (Roadmap-4 PR-9): every
  `<ConfirmDialog tone="danger">` confirmLabel MUST start with one of
  the canonical verbs below. Pick the one that matches the actual
  effect — the verb is the user's last clue before they commit.
    - **`Delete {Entity}`** — permanent erasure of a top-level entity
      or configuration (`Delete configuration`). The data is gone.
    - **`Remove {Item}`** — detach an item from a parent OR turn off
      an enrollment (`Remove MFA`, `Remove document`). Source row may
      live on.
    - **`Revoke {Credential}`** — invalidate an authority / credential
      (`Revoke API key`, `Revoke SCIM token`, `Revoke session`).
    - **`Discard {Draft}`** — abandon unsaved or draft state.
    - **`Archive {Entity}`** — soft delete with history preserved.
    - **`Unlink {Entity}`** / **`Detach {Entity}`** — break an
      association without deleting either side.
    - **`Reject {Request}`** — refuse an approval request or finding.
  Forward enforcement at `tests/guards/destructive-vocabulary.test.ts`.
- **Search placeholder vocabulary** (PR-9): every `<FilterToolbar
  searchPlaceholder>` value follows `Search {entityPlural}…`. One
  ellipsis (`…`, single character — not `...`). NEVER append a
  parenthetical hint like `(Enter)` / `(Press Enter)` — the
  FilterToolbar search is **live** (typing filters the table on a
  short debounce, no Enter required), so an Enter hint would be
  actively wrong. Forward enforcement at
  `tests/guards/search-placeholder-vocabulary.test.ts`. The same
  format applies to i18n `searchPlaceholder` values in `messages/`.
  Free-text search lives **inside the Filter dropdown**, NOT in a
  separate search bar: passing `searchPlaceholder` turns the Filter
  popover's top input into a live content search (the categories stay
  listed below it). Every standard list page MUST wire `searchId` +
  `searchPlaceholder` (the R14-PR7 kill sweep was reversed 2026-05-30,
  then the search was moved into the filter bar per user directive);
  presence is locked by `tests/guards/r14-no-page-searchbars.test.ts`.

## Implementation notes

Every substantive prompt — architectural decisions, new features, security
or infrastructure changes, anything worth revisiting in six months — lands
a short markdown file in `docs/implementation-notes/<YYYY-MM-DD>-<slug>.md`
alongside the code + tests. Commit messages carry the `what + why`; these
notes carry the `design + decisions + tradeoffs` in a grep-friendly form.

**Default structure** (skip any section that doesn't apply):

```markdown
# YYYY-MM-DD — <feature name>

**Commit:** `<sha> <commit subject>`

## Design
<architectural shape — diagrams or prose, 10-30 lines>

## Files
<table of files changed with one-line role per file>

## Decisions
<bullet list of non-obvious tradeoffs and why they went the way they did>
```

**Do NOT include a "Tests added" section** — the test files themselves
are the durable record. Duplicating counts into docs creates rot when the
test list moves.

**Skip** for small UI tweaks, config bumps, bug fixes that don't shift
architecture. The bar is "would a future engineer need the context?"

Existing examples: `docs/implementation-notes/2026-04-22-*.md`.

## Doc classifications

Every file in `docs/**/*.md` is classified in
`docs/_status/doc-classification.json` (the source of truth) as exactly
one of four kinds. The ratchet `tests/guardrails/docs-accuracy.test.ts`
keeps the markers honest — pick the right class when you add a doc.

- **`authoritative`** — describes shipped behaviour; **every claim must
  be true today**. This is the DEFAULT for any new doc. The ratchet
  fails CI if an authoritative doc contains a future-tense marker
  (`coming soon`, `not yet`, `TODO`, `FIXME`, `WIP`, `will be`,
  `roadmap`) outside an allowed context: a fenced code block, a tail
  `## Future work` / `## Future scaling` / `## Future direction` / `## Roadmap`
  section, a markdown-link target, or a line carrying
  `<!-- docs-accuracy-allow: <reason> -->`. When something ships,
  rewrite the doc in present tense — don't leave "will be".

- **`living`** — a design direction that is PARTIALLY shipped; explicit
  future-tense is intentional. Must carry the banner
  `> **Status: living design** — …` and split the body into
  `## Current state (true today)` + `## Roadmap (future direction)`.

- **`historical`** — a moment-in-time record. The ENTIRE
  `docs/implementation-notes/` subtree is historical by path (and
  READ-ONLY — do not edit those except to fix typos). `docs/adr/` is
  banner-exempt too (its location is the marker) but its class is still a
  per-file decision. Every other historical doc (dated audits, executed
  migration plans) carries
  `> **Status: historical record (YYYY-MM-DD)** — …` and points at the
  current authoritative doc.

- **`deprecated`** — the system it described is gone/superseded. Replace
  the body with `> **Deprecated.** … superseded by docs/<replacement>.md`.
  Don't delete the file (inbound cross-links).

When you add a doc, add its entry to `doc-classification.json` in the
same PR — the ratchet's bidirectional cross-walk fails otherwise.

**Exception, and it covers the common case: an implementation note needs NO
entry, and adding one now FAILS the ratchet.** `docs/implementation-notes/**`
is classified BY PATH as `historical`, because that is what the subtree means
— the class was never a per-file decision. It used to be stored anyway, at
549 of 675 entries, and each new note appended to the same place in the file:
adding a key rewrites the previous entry's `}` into `},`, so two PRs edit one
line and conflict. That cost five rebases in a single night (2026-08-19),
each discarding a green CI run. `docs/adr/` is deliberately NOT derived — a
superseded ADR legitimately becomes `deprecated`, so its class is still a
decision.

For every other doc, add ONLY the entry: the file carries no per-class `counts` header, and re-adding one
fails the ratchet even if the number is right. It was derived data stored
beside its own source, and the way it broke is worth remembering — two
branches each bumping `494 → 495` do not CONFLICT, so git keeps one copy,
both PRs are green, and main is wrong by one with no suspicious diff for a
reviewer to catch. A clean merge was the dangerous case, so the header is
gone rather than monitored.

### The public docs sites

One GitHub Pages deployment (Starlight, built and deployed by
`.github/workflows/docs-site.yml`) carries TWO sites, each with its own
navigation and search:

- **The help site**, https://rodnapamet.github.io/inflect-compliance/, is for
  people who USE the product and publishes `docs/user/` and nothing else —
  page guides, how-tos, runbooks. No source paths, permission keys, API routes
  or implementation detail: the owner rejected an engineering-flavoured page
  guide on 2026-10-24, and that is the line.
- **The developer site**, …/inflect-compliance/developers/, carries the
  architecture, security and contributor docs and the generated reference in
  `docs/reference/`. It never publishes `docs/user/`; a link from a developer
  doc to a user doc crosses to the help site.

Each site publishes only what `site/<site>/manifest.json` lists. **A manifest is
an ALLOWLIST: a new doc is NOT published until somebody adds it**, so writing a
doc never publishes it by accident. `SITES` in `site/scripts/stage-docs.js`
holds which folders each site may list as a folder, and a doc listed by both
sites stops the build. `tests/guardrails/docs-site-publication.test.ts` holds
both manifests on every PR.

Two more rules in the stager refuse the build, and are easy to undo by
"simplifying":

- **`NEVER_PUBLISH`** is the owner's decision of 2026-10-23 — the deployment
  and production-VM guides, the runbooks and the DPA template stay off BOTH
  sites. The guardrail restates that list, so emptying the constant fails CI.
- **`FORBIDDEN_CONTENT`** refuses a published doc that names a coordinate of
  the production estate: the GCP project id, the VM's host path, zone or
  access command, a person's `@inflect.bg` address, the production env file.
  The fix for a hit is to rewrite the line in the doc, never to loosen the rule.

**Exclusion is not confidentiality.** The repository is public; every file in
`docs/` — and this file — is already readable on github.com. Keeping a doc off
the sites keeps it out of their navigation and search. A secret never goes in
`docs/` at all. See `docs/docs-site.md`.

**Help-site docs** (`docs/user/guide/<sidebar section>/<page>.md`,
`docs/user/how-to/`) and the **generated reference** (`docs/reference/`) are
classified `authoritative` BY PATH, so they need no classification entry
(adding one fails docs-accuracy), and once a manifest lists their folder a new
file needs no manifest line either. A page guide names its page in `route:`
frontmatter and writes on-screen labels as `{{ui:<key>}}` from
`messages/en.json`. The docs build refuses a route that matches no `page.tsx`
and a key that does not resolve; the Ratchets guardrail deliberately checks
neither, so renaming a label in the app never fails a code PR.

**The developer reference is generated, never hand-written.** Each
`docs/reference/*.md` is a short introduction around a line holding only
`{{generated:<name>}}`; `scripts/docs-reference/generate.ts` writes the
fragments (roles × permissions from `getPermissionsForRole`, the page
inventory, each page's API calls and the permission each reaches, the refusal
codes) into the gitignored `site/.generated/`, and a page whose fragment is
missing stops the build. Its coverage figures (pages with no help guide, share
of API calls matched) are notices, never a gate. Template and rules:
`docs/docs-site.md`.

## UI Platform — Epics 51–60

The following epics established shared primitives, guardrail tests, and
contributor guides. **Always use the platform primitives** — never
hand-roll a replacement. Each section points to its decision-tree doc.

### Epic 51 — Design Tokens & Theme System

Use semantic token classes (`bg-bg-default`, `text-content-muted`,
`border-border-subtle`) instead of raw Tailwind color scales
(`bg-slate-800`, `text-slate-400`). Use `<Button>`, `<StatusBadge>`,
and `<EmptyState>` components instead of legacy `.btn` / `.badge` CSS
classes. See `docs/token-cheatsheet.md` and `docs/ui-buttons.md`.

### Epic 52 — DataTable Platform

Every list page must use `<DataTable>` from `@/components/ui/table`.
Never add raw `<table>` elements in app pages. Use the
`useListPagination` adapter for cursor-based APIs. See
`tests/guards/epic52-datatable-ratchet.test.ts`.

**List-page layout (the viewport-clamped scroll pattern):**
Wrap the page in `<ListPageShell>` from `@/components/layout/ListPageShell`
and pass `fillBody` to the primary `<DataTable>`. Result: the table
card fits the viewport, only the table body scrolls — page header,
filter toolbar, and pagination footer stay anchored. On mobile (<md)
the shell is a no-op and natural document scroll resumes.

```tsx
<ListPageShell>
  <ListPageShell.Header>...</ListPageShell.Header>
  <ListPageShell.Filters><FilterToolbar ... /></ListPageShell.Filters>
  <ListPageShell.Body>
    <DataTable fillBody data={...} columns={...} />
  </ListPageShell.Body>
</ListPageShell>
```

A new app page that imports `DataTable` MUST either wrap in
`<ListPageShell>` — or in `<EntityListPage>`, which mounts it
internally; the ratchet accepts either — OR add itself to
`EXEMPTIONS` in `tests/guards/list-page-shell-coverage.test.ts`
with a written reason. Exemptions exist for multi-section dashboards (Coverage,
admin/api-keys, admin/notifications, admin/integrations) and
detail-page sub-tables / wizards (risks/import) where viewport-
clamping doesn't fit. See `docs/epic-52-list-page-shell.md` for the
decision tree.

### Entity-page architecture (`EntityListPage` + `EntityDetailLayout`)

Three composition shells live in `src/components/layout/` —
`EntityListPage` (list pages), `EntityDetailLayout` (detail
pages), and `DashboardLayout` (dashboard composites). Both carry **layout, not business content**. Reach for them
whenever you build a new entity page; never re-introduce the inline
`<ListPageShell> + <FilterToolbar> + <DataTable>` block or the
inline back-link / title / tab-bar / loading-skeleton dance.

```tsx
// List page — controls reference impl: ControlsClient.tsx
<EntityListPage<Row>
  header={{ title, count, actions }}
  filters={{ defs, searchId, searchPlaceholder, toolbarActions }}
  table={{ data, columns, getRowId, onRowClick, emptyState, … }}
>
  {/* page-level modals/sheets sit as children */}
</EntityListPage>

// Detail page — controls reference impl: controls/[controlId]/page.tsx
<EntityDetailLayout
  back={{ href, label }}
  title={…}
  meta={…}
  actions={…}
  loading={…}
  error={…}
  empty={…}
  tabs={…}
  activeTab={…}
  onTabChange={…}
>
  {/* active-tab content owned by the page */}
</EntityDetailLayout>
```

The shells are reusable; the pages stay opinionated. Column defs,
filter defs (including runtime-derived options), data fetching,
mutations, optimistic updates, modals, sheets, permission gates,
and domain-specific tab bodies (e.g. `TraceabilityPanel`,
`LinkedTasksPanel`, `TestPlansPanel`) all stay in the page.

**When NOT to reach for these shells.**

  - Multi-section dashboards — reach for `<DashboardLayout>`, the
    third shell, not `EntityListPage`/`EntityDetailLayout`. They
    remain in the Epic 52 `EXEMPTIONS` list (Coverage,
    admin/api-keys, admin/notifications, admin/integrations)
    because they are not viewport-clamped list pages; adoption is
    tracked in `tests/guards/dashboard-shell-coverage.test.ts`.
  - Wizards / multi-step flows where the page isn't a single list or
    detail (risks/import).
  - Sub-tables nested inside a detail tab — `<DataTable>` directly
    is the right primitive there, not `<EntityListPage>`.

**Adoption ratchets.** Adoption is tracked by registry ratchets,
not one test per page: `tests/guards/entity-detail-shell-coverage.test.ts`
and `tests/guards/entity-detail-layout-coverage.test.ts` carry an
`adopted` flag plus a written note for every entity detail page,
and `tests/guards/dashboard-shell-coverage.test.ts` does the same
for dashboards. Three pages additionally carry a per-page
structural test — `tests/unit/controls-client-shell-adoption.test.ts`
and `tests/unit/policies-list-shell-adoption.test.ts` (list),
`tests/unit/control-detail-shell-adoption.test.ts` (detail). When
you migrate a new entity page, graduate its registry entry to
`adopted: true`; a per-page `*-shell-adoption.test.ts` is optional.
Already on `EntityListPage`: controls, policies, vendors,
incidents, vulnerabilities, security-testing, AI systems,
information registry, business-continuity, and admin
devices/personnel/training. Risks is the notable holdout —
`RisksClient.tsx` still hand-rolls `<ListPageShell>`.

See `docs/implementation-notes/2026-04-30-entity-page-architecture.md`
for the unified architecture rationale and
`docs/implementation-notes/2026-04-30-entity-detail-layout-extraction.md`
for the detail-shell extraction.

### Epic 53 — Enterprise Filter System

Use `FilterProvider` + `useFilterContext` from
`@/components/ui/filter/` and `FilterToolbar` from
`@/components/filters/FilterToolbar` for list-page filtering. Never build ad-hoc
`useState` + manual URL sync. See
`src/components/ui/filter/GUIDE.md` and `docs/filters.md`.

### Epic 54 — Modal & Sheet Strategy

Use `<Modal>` for quick create/edit/confirm flows and `<Sheet>` for
inspect-and-edit without losing list context. Never hand-roll a
`fixed inset-0 bg-black/…` overlay. See `docs/modal-sheet-strategy.md`.

### Epic 55 — Combobox & Form Primitives

Use `<Combobox>` for selection lists, `<UserCombobox>` for people
pickers, `<RadioGroup>` for 2–5 visible choices, and wrap every
field with `<FormField>`. Never use raw `<select>` or
`<input className="input">` in app pages. See
`docs/combobox-form-strategy.md`.

### Epic 56 — Tooltip & Copy Primitives

Use `<Tooltip>` for hover/focus hints, `<InfoTooltip>` for help icons,
`<CopyButton>` / `<CopyText>` / `useCopyToClipboard` for clipboard.
Never use raw `navigator.clipboard` or add new `title=` attributes.
See `docs/tooltip-and-copy-strategy.md`.

### Epic 57 — Keyboard Shortcuts & Command Palette

Register shortcuts via `useKeyboardShortcut` — never
`document.addEventListener('keydown', …)`. Always supply a
`description`. See `docs/keyboard-shortcuts.md`.

### Epic 58 — Date Pickers

Use `<DatePicker>` for single dates and `<DateRangePicker>` for
ranges. Use `formatDate` / `formatDateTime` from `@/lib/format-date`
for display. Never use `<input type="date">` or raw
`toLocaleDateString`. See `docs/date-picker.md`.

### Epic 59 — Dashboard Charts

When adding or modifying charts/visuals on any dashboard page,
always use the shared chart platform. See `docs/charts.md` for the
decision tree. Never use raw `<svg>`, `<polyline>`, or inline
`style={{ width: \`\${pct}%\` }}` progress bars.

### Epic 60 — Shared Hooks & Polish Primitives

Import shared hooks from `@/components/ui/hooks` (barrel): `useLocalStorage`,
`useOptimisticUpdate`, `useEnterSubmit`, `useInputFocused`, `useScroll`,
`useScrollProgress`, `useInViewport`, etc. Use the polish primitives
`<Accordion>`, `<TabSelect>`, `<ToggleGroup>`, `<Slider>`,
`<NumberStepper>` for dense interaction areas. Never hand-roll a tab
bar, segmented filter row, `localStorage` cache, Enter-submit handler,
or `<input type="number">` stepper — reach for the shared primitive. See
`docs/epic-60-shared-hooks-and-polish.md` and the ratchet
`tests/guards/epic60-ratchet.test.ts`.

### Epic 60 — Automation Events & Dispatch (backend)

The event-driven backbone the rule-builder epic will stand on.
Import everything from `@/app-layer/automation` (single barrel).
Emit via `emitAutomationEvent(ctx, input)` — never construct
`AutomationExecution` rows directly from a usecase. When adding a
new event: add to `events.ts`, add the typed variant to
`event-contracts.ts`, emit from the usecase (or audit emitter), and
write a wiring test. Action handlers, rule-builder UI, and filter
DSL evolution all plug into clearly-marked seams — don't bypass
them. See `docs/automation-events.md` for the full contributor
guide and the decision-tree for extensions.

### Epic 67 — Destructive-action undo-toast convention

Every delete / unlink / remove flow in the product MUST use
`useToastWithUndo()` from `@/components/ui/hooks`. The hook returns
a stable `trigger` function that schedules the destructive commit
to fire 5 seconds after the click; during that window a custom
toast renders with an Undo button + animated countdown bar. Click
Undo and the timer is cancelled — the destructive write never
happens. The pending state lives at module scope (NOT in component
state) so commits survive client-side navigation, mirroring Gmail's
"undo send" UX.

The wired sites today number 14 — the authority is `SITE_CONTRACTS`
itself, not this list. They include cross-entity unlink in
`TraceabilityPanel`, control-evidence and control-requirement unlink on
the control detail page, task link removal, vendor document removal,
auditor pack-grant revoke, and BIA dependency removal. The structural
ratchet
at `tests/guards/epic-67-rollout-coverage.test.ts` locks the wiring
in — adding a new site means appending it to `SITE_CONTRACTS`.

Never write a `confirm()` blocking dialog or a fire-and-forget
direct DELETE for a routine destructive action — those are the
anti-patterns Epic 67 replaces. Top-level entity deletion (tenant,
organization, framework) is the documented exception: cascading
consequences mean the 5-second window is too short, so use a
typed-confirmation modal there instead.

See `docs/destructive-actions.md` for the canonical wiring (snapshot
+ optimistic remove + trigger), the four invariants every site must
satisfy, message-tone rules, when NOT to use the pattern, and the
test layout (hook hardening at
`src/components/ui/hooks/__tests__/use-toast-with-undo.test.ts`,
baseline + UI tests under `tests/rendered/`, structural ratchet
under `tests/guards/`).

### Epic 68 — List virtualization

Single shared windowing primitive (`<VirtualizedList>`) wraps
`react-window` v2, which sizes itself — `react-virtualized-auto-sizer`
is no longer a dependency of this repo. New surfaces go
through the primitive rather than importing `react-window` directly.
It is not the only seam today: `src/components/ui/table/virtual-table-body.tsx`
(the `<VirtualTable>` behind `<DataTable>`) imports `react-window`
directly, because a table body has to render `<tr>`/`<td>` into a
`<tbody>` and cannot nest the primitive's own scroll container.

Two production rollouts:

- **`<DataTable>` rows** — auto-virtualizes when `data.length > 1000`.
  Threshold raised from 100 → 1000 in a follow-up to scope auto-
  virtualization to genuinely large unpaginated tables (the lower
  threshold caused click-intercept regressions on medium-sized
  tables in Playwright). `virtualize={false}` opts out (Controls
  page contract). `virtualize={{ threshold: N }}` customises.
  Pages that legitimately need virtualization on smaller datasets
  should opt in explicitly. Falls back to the standard `<Table>`
  automatically when server-side pagination, aligned sub-rows
  (`renderAlignedSubRows`), or empty/error/loading chrome is
  requested. Column resizing is NOT a fallback trigger — it is
  silently force-disabled while virtualizing.
- **`<Combobox>` / `<UserCombobox>` dropdowns** — auto-virtualize
  when visible options exceed `COMBOBOX_VIRTUALIZE_THRESHOLD = 50`.
  cmdk's nav (which assumes items live in the DOM) is bypassed in
  the virtualized branch via a bespoke capture-phase keyboard layer
  bound to the search input — ArrowDown / ArrowUp / Home / End /
  Enter all flow through there with `aria-activedescendant` tracking.
  `<UserCombobox>` is a thin wrapper over `<Combobox>` so it gets
  virtualization for free.

Performance contract: any list above the threshold renders ≤30 row /
option nodes regardless of dataset size. The test in
`tests/rendered/combobox-virtualize.test.tsx` locks that DOM count at
1000 options. It also carried a `<2s` wall-clock budget over the same
render+open until 2026-09-06; that was removed because its verdict on
the regression it named was a coin flip — with all 1000 items rendered,
eight measured samples straddled the ceiling (1318-2397 ms, four over
and four under), while the DOM count read 1000 against `<=30` every
time. The count is the sole detector and the only machine-independent
one; what it gives up is nodes that each got more expensive to build.

See `docs/list-virtualization.md` for the rollout decision tree
(when to use the primitive directly vs reach for `<DataTable>` /
`<Combobox>`), the five `VirtualizedList` contract rules, the
DataTable + Combobox preserved/dropped feature lists, and the test
layout.

### Risk Quantification — RQ3 roadmap (complete)

The risk-quantification cohort (RQ3-1 → RQ3-10 + the six OB-* polish
points) is the architectural shift from "qualitative and quantitative
side-by-side" to "loss distribution leads, sensors update beliefs,
controls carry a price". The wave reshaped the dashboard, added a
board view, closed the KRI ⇄ assessment loop, and introduced
Mitigation ROI — each PR carries an implementation note.

**Read the capstone first:** [`docs/rq3-roadmap-complete.md`](docs/rq3-roadmap-complete.md).
It indexes every implementation note (`docs/implementation-notes/`) and
the load-bearing decisions a new contributor needs to understand the
post-RQ3 codebase.

The capstone's index is checked by `npm run docs:lint`, which is
**advisory and not wired into CI**. It used to be gated by
`tests/guards/rq3-11-capstone.test.ts`, deleted 2026-08-06: requiring
every `rq3-*.test.ts` filename to appear in a markdown file meant
shipping an RQ3 follow-up turned CI red until the filename was pasted
into prose — and since the convention also asked for a ratchet per PR,
the cheapest path back to green was writing another ratchet. See
**[the epic-ratchet lifecycle](#epic-ratchet-lifecycle)** above for the
policy that replaced it.
