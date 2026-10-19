# New-subsystem checklist

A checklist for adding a new **provider**, **tenant-scoped model**, or
**background job** so it inherits the platform's runtime-verification
conventions *by construction* — the hardening wave (H1–H6, GAP-1..4) learned
each of these the hard way, and each item is now backed by a **structural
ratchet that fails CI** until the item is satisfied.

> **The meta-rule.** Structural ratchets certify **shape** (does the RLS policy
> exist, is the field indexed). Behavioural ratchets certify **conduct** (does a
> tenant-B caller actually get denied, does a broken collector actually return
> ERROR). A new subsystem needs **both** — the ratchets below enforce it so the
> convention is inherited, not rediscovered in the next audit.

## 1. Fail-closed check semantics (new `ScheduledCheckProvider`)

A monitoring product must never manufacture a passing signal it hasn't earned.
`runCheck` MUST return **ERROR** (broken collector / client error) or
**NOT_APPLICABLE** (empty output / zero-applicable population) — **never
PASSED** — when it has no evidence.

- [ ] Write a fail-closed test proving `runCheck` returns ERROR/NOT_APPLICABLE
      on client-error, empty-output, and zero-applicable input (see
      `tests/unit/h2-fail-closed.test.ts` for the engine-level shape, or a
      provider-level `runCheck` throws→ERROR test like
      `tests/unit/identity-providers.test.ts`).
- [ ] Map the provider in `FAIL_CLOSED_COVERAGE` in
      `tests/guardrails/provider-fail-closed-coverage.test.ts`.
- **Ratchet:** a newly-registered provider that isn't mapped fails CI.

## 2. Two-tenant behavioural isolation (new tenant-scoped model)

RLS + the `rls-coverage` structural proof are necessary but not sufficient —
they certify the policy *exists*, not that the usecase path *honours* it.

- [ ] Add a two-tenant behavioural test that drives the real usecases/repos
      under two tenant contexts and asserts a tenant-B caller cannot read/mutate
      tenant-A rows (see `tests/integration/wave-features-rls.test.ts`).
- [ ] List the model in `ISOLATION_TESTED` in
      `tests/guardrails/tenant-isolation-forward-lock.test.ts` — or, if a
      behavioural test is a deliberate follow-up, in `ISOLATION_BASELINE`
      (rls-coverage is the interim structural proof).
- [ ] Give the model a `tenantId`-leading `@@index` and RLS policy triple
      (enforced separately by `schema-index-coverage` + `rls-coverage`).
- [ ] If the model records a PERSON's decision about rows a machine writes
      (a confirmation of a scanner's link), keep it in its own table rather than
      columns on the machine-written one, whose single write seam would then own
      a human decision. Make it one-way at the database (a `BEFORE UPDATE`
      trigger, no `DELETE` for `app_user`) and invalidate it, never re-point it,
      when the machine's rows move — `AgentServicePrincipalConfirmation` is the
      worked example, and its integration test proves the trigger.
- **Ratchet:** a new tenant-scoped model in neither set fails CI.

## 3. Runtime wiring (new provider or background job)

Code that exists but is never reached in production is a silent failure (H1: the
provider registry started empty because no runtime entrypoint imported the
bootstrap).

- [ ] A new integration provider is registered in
      `src/app-layer/integrations/bootstrap.ts` (reachability from
      `instrumentation.ts` + `scripts/worker.ts` is already locked).
- [ ] A new background job registered in `executor-registry.ts` is EITHER
      scheduled in `schedules.ts` OR added to `ON_DEMAND_JOBS` in
      `tests/guardrails/runtime-wiring-coverage.test.ts` with a reason.
- **Ratchet:** an unwired executor job (a cron written but never scheduled)
      fails CI.

## 4. Outcome metric (new check / sync / generation surface)

A subsystem whose defining failure mode is going green silently needs an
alertable signal.

- [ ] Emit a domain metric via `src/lib/observability/integration-metrics.ts`
      (`recordCheckOutcome`, `recordSyncTruncated`, …) or the connection
      freshness gauge, so "went green" vs "no data" vs "silently dead" is
      distinguishable on the dashboard. (A convention enforced by review — no
      structural ratchet.)

## 5. Authorization gate (new privileged API route)

- [ ] Wrap the handler with `requirePermission('<key>', …)` from
      `@/lib/security/permission-middleware` and add a rule in
      `route-permissions.ts` (enforced by `api-permission-coverage`).
- [ ] For a new admin route, add it to the relevant coverage lists
      (`admin-route-coverage`, and the DataTable/shell coverage guards if it
      renders a table).
- [ ] A token-gated endpoint has no session behind its caller, so it cannot take
      `requirePermission`. The outbound MCP endpoints whose only client is our own
      external-write dispatch (`/api/mcp/entra-grant`,
      `/api/mcp/entra-service-principal`) are this kind, and so is the inbound
      A2A endpoint (`/api/a2a`), whose caller is another organisation's agent.
      Triage it into
      `PROTOCOL_CREDENTIAL` in
      `tests/guardrails/api-route-has-some-authorization.test.ts`, naming the
      mechanism its handler calls, and write the `AUTHZ_DENIED` row explicitly for
      every refusal that can be attributed to a tenant. If it writes to a
      directory, list its Graph client and usecase in `IDENTITY_WRITE_PATH` in
      `tests/guards/identity-log-identifier-scrub.test.ts`.
- **Ratchet:** an untriaged route fails `api-route-has-some-authorization`.

---

See the implementation note
`docs/implementation-notes/2026-07-10-runtime-verification-conventions.md` for
the rationale and the shape-vs-conduct framing.
