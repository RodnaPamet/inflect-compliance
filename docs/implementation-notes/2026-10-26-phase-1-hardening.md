# 2026-10-26 — Phase 1 hardening: the builder's invariants, and a per-tenant switch (Claude agents 1H)

**Commit:** `<sha> feat(agentic): open agent profiles to named tenants, and prove the builder's invariants (Claude agents 1H, part 1)`

Step 1H of the roadmap in `docs/claude-agent-sdk-design.md` (#4145), first of
two pull requests. This one answers the adversarial questions about Steps 1a and
1b together, each with the test that holds the answer. It runs the injection
corpus through both save paths and proves the tenant purge. It also adds
`AGENT_PROFILES_TENANTS`, so a proving tenant can author and approve a real
profile in production while no other tenant sees the surface (owner decision 8).
The second pull request records that profile in the evidence table.

## Design

```
route  ── whenAgentProfilesEnabled ── slug from the URL ──┐
page   ── agentProfilesOn(tenantSlug) ────────────────────┤
usecases, admission ── agentProfilesOn(ctx.tenantSlug) ───┴─▶ agentProfilesEnabledFor(
                                                               AGENT_PROFILES,
                                                               AGENT_PROFILES_TENANTS,
                                                               slug)
```

One pure function answers every gate. The deployment switch still opens the
surface to every tenant. The allowlist opens it to the slugs it names, read
trimmed and case-insensitive. No slug is never named, so a context that carries
none fails closed.

## The adversarial read

| Question | Answer | Held by |
| --- | --- | --- |
| Can a profile name a tool the agent loses later, and what happens at run time? | It cannot keep one silently. Save refuses an ungranted tool by name, and approval checks every tool again, so a grant revoked while a version waits is refused at approval. After approval, a run is offered the version's tools intersected with the agent's grants at that moment. Each lost tool is recorded as `PROFILE_TOOL_NOT_GRANTED`, and an empty intersection offers nothing. | `agent-profiles.test.ts` › "TOOL_NOT_GRANTED names every ungranted tool…", › "a grant revoked while a version waits is refused at approval, by name"; `engine-tools-core.test.ts` › "5. an agent profile only narrows what is offered" |
| Can the Test run start on a DRAFT? | No. The tab's Test run has no start path in this build. A DRAFT's run key is refused at admission with `PROFILE_VERSION_NOT_APPROVED`, as is any version that is not the approved one in force. Step 2c's start route must keep that for a DRAFT; its carried obligations name the versions it may admit. | › "a version that is not the one in force is refused" (the version it starts is a DRAFT); `agent-behaviour-tab.test.tsx` › "is not offered on a draft" |
| Can a SUBMITTED version be edited under its approver? | No. Its text and settings are frozen by trigger for every role. An edit is a new version that retires the open one, so the approver's approve answers `NOT_SUBMITTED`. The one change the trigger admits is the rotation sweeps' re-wrap. Ciphertext copied over it that way passes the trigger, but approval recomputes the hash from the decrypted text and refuses (`HASH_CHANGED`), and the version stays SUBMITTED. **New test.** | › "a submitted version whose text is swapped under the re-wrap exception cannot be approved" |
| Does any route return another tenant's profile under a guessed id? | No. Every route is keyed by an agent id under the URL's tenant. `getTenantCtx` requires a membership there, and the usecases filter on `tenantId` with RLS beneath. A guessed agent id from another tenant is `AGENT_NOT_FOUND`, and a guessed run key is `PROFILE_NOT_FOUND`. The allowlist adds no path: the slug it is checked against is the tenant the caller is acting on, which the context then binds. | › "tenant B never reaches tenant A's profile" (three tests); › "AGENT_PROFILES_TENANTS opens the surface to the tenants it names, and to no other" |
| Does the instructions hash match what the run will send? | Yes for the text: the resolver recomputes the hash of the decrypted instructions on every resolution, refuses a mismatch (`PROFILE_HASH_MISMATCH`), and hands the engine exactly the text it hashed. The hash covers the instructions, not the whole prompt. The fence an engine renders around them is Step 2b's obligation. **New assertion.** | › "resolves only the approved version in force…" (the resolved text hashes to the pin); › "PROFILE_HASH_MISMATCH: text swapped in under the re-wrap exception does not run" |
| Can the allowlist be steered by the caller's URL? | No. The route gate reads the URL's slug, but the handler builds its context for that same slug and needs a membership there. The usecases then check `ctx.tenantSlug`, which comes from the tenant row. Naming a tenant in the URL is only ever acting on it. A renamed tenant drops off the list, which fails closed. | `agent-profile.test.ts` › "4. AGENT_PROFILES_TENANTS opens the routes…"; the integration test above |
| Can text widen authority? | No. The instructions are scanned at save and at approval. A tool they name that the version does not declare is refused (`skill.undeclared_tool`). What a run may call is decided by the tool list and the grants, never by the text. | › "refuses the skill.undeclared_tool family by its rule id, and stores nothing" |

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-profile.ts` | `profileTenantAllowlist`, `agentProfilesEnabledFor` |
| `src/lib/agentic/agent-profile-flag.ts` | the route gate reads the URL's slug |
| `src/app-layer/usecases/agent-profiles.ts` | `agentProfilesOn(tenantSlug)`, called with `ctx.tenantSlug` |
| `src/app-layer/usecases/agent-profile-runs.ts` | admission asks the same, per tenant |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/page.tsx` | the tab, per tenant |
| `src/env.ts` | `AGENT_PROFILES_TENANTS` |
| `tests/guardrails/sub-processor-coverage.test.ts` | the variable's triage |
| `tests/unit/agentic/agent-profile.test.ts` | the route gate per tenant; the list's parsing |
| `tests/integration/agent-profiles.test.ts` | the allowlist, the swap under review, the resolved text's hash, the corpus storing nothing |
| `tests/integration/agent-profile-tenant-purge.test.ts` | the purge |
| `docs/data-retention.md` | `rejectionReason` is encrypted too |

## Decisions

- **Slugs, not tenant ids.** The route gate runs before any context exists, and
  the URL carries the slug. An id list would need a database read in front of
  every profile route to translate it. A renamed tenant drops off the list,
  which fails closed, and the list is meant to be short-lived.
- **One function for every gate.** The route, the page, the usecases and
  admission all ask `agentProfilesEnabledFor`. Two readings of the same two
  variables would one day disagree, and the disagreement would show as a tab
  whose routes 404.
- **The corpus runs through both save paths.** The first version also creates
  the profile row, so it is the path most likely to store something before it
  refuses. Each case asserts that neither a profile nor a version row was
  written.
- **The purge test uses the real usecases and the real purge.** Hand-written
  rows would skip the trigger and the encrypted columns, and those are what a
  purge has to get through. Children go first, so each table reports exactly
  the rows it held, rather than losing them to a parent's cascade.
- **Two pull requests.** The evidence needs the allowlist deployed. This one
  says "Part of #4145", and the evidence pull request closes it.
