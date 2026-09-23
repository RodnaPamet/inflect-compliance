# 2026-09-23 — The tenant's half of the agentic-driver gate becomes writable

**Commit:** `<sha>` feat(agentic): a tenant's agentic driver can be set, and the setting reports the whole gate

## The defect

`TenantSecuritySettings.agentDriver` shipped with everything except a writer:
an enum, a `@default(STATIC)`, a schema comment describing a two-key gate, and
a reader (`resolveDriverForTenant`) consulted on every agentic run. Zero write
sites in `src/`.

Nothing was broken in a way a type or a test could see. The read worked, the
default was right, the fail-closed behaviour was correct. It was simply
impossible for any tenant to reach the other value through the product — so
the "customer's half of the gate" was a constant wearing a switch's name, and
the only way to move one was an `UPDATE` against production by hand: no
authorization, no audit row, and no record afterwards of who decided it.

This is the failure mode the agentic and identity subsystems keep naming in
their own comments — *settable and inert*, or here *gated and unsettable*.

## Design

`getAgentDriverSetting` / `setAgentDriverSetting` in
`src/app-layer/usecases/agent-driver-setting.ts`, behind
`GET`/`PUT /api/t/{slug}/admin/agent-driver`, gated `admin.tenant_lifecycle`.

The shape is `setIdentityWriteMode`'s, which is the nearest thing in the repo:
the customer-side half of a two-key gate over authority that reaches the
customer's own data.

**But there is no ladder, and that is the deliberate difference.** The identity
ladder exists because its rungs are progressively more dangerous and the dwell
buys observation time between them. This is two values, both of which run the
same register controls in front of every tool call, neither of which can act
without the operator's switch. A dwell here would gate nothing that the
operator's own key does not already gate — and the narrow back to `STATIC` is
the kill switch somebody reaches for while a run misbehaves, so a cooldown on
the way *down* is how a safety control becomes the incident.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/agent-driver-setting.ts` | the read and the only write; the audit row |
| `src/app/api/t/[tenantSlug]/admin/agent-driver/route.ts` | GET + PUT, OWNER-only |
| `src/lib/security/route-permissions.ts` | the rule that makes the gate a gate |
| `tests/unit/agent-driver-setting.test.ts` | behaviour, including every combination of the three terms |
| `tests/guards/agent-driver-column-has-a-writer.test.ts` | the defect as a property of the column |
| `public/openapi.json` | the route's stub entry (regenerated) |

## Decisions

- **The GET returns the whole conjunction, not the stored value.**
  `resolveAgentDriver` ANDs three terms and this usecase owns one. A tenant set
  to `FLUE` in a deployment whose `AGENT_DRIVER_FLUE` is off runs on the static
  engine, and a surface reporting only `mode` would show FLUE while every run
  went elsewhere — settable-and-inert again, this time reported as working. The
  identity write-policy route's `honoured` block exists for exactly this reason
  and is the model. The effective driver is computed by calling the function
  the run path calls, not by re-deriving the AND: a second copy of the
  conjunction is how a settings page ends up reporting a capability the runtime
  refuses.
- **`admin.tenant_lifecycle`, so OWNER-only.** Switching to `FLUE` hands an
  external agent runtime the decision of what to *try* against this tenant's
  compliance data. `runReadTool` still decides what is *permitted*, so no
  register control moves — but who may make that change is authority of the
  tenant-deletion / DEK-rotation class, and ADMIN deliberately does not hold
  it.
- **The write is an `upsert`.** The tenants nobody has configured anything for
  are exactly the ones with no `TenantSecuritySettings` row, and exactly the
  ones a first enablement is aimed at. An `update` alone throws P2025 on them.
- **The audit row records the OTHER key's state.** Without `envEnabled` in the
  metadata the trail cannot distinguish "switched to FLUE and ran on Flue" from
  "switched to FLUE and kept running static because the deployment switch was
  off" — two very different sets of runs, and a distinction that is
  unrecoverable once the env var next changes.
- **Category `access`, not `configuration`**, for the same reason the identity
  ladder is: an access-review reader is the audience for a change that decides
  whether a model is driven over the tenant's data.
- **No UI.** The route is the minimum that makes the column reachable, which is
  what the first enablement needs. A toggle beside the identity ladder's
  `WriteLadderClient` is the obvious next step and is deliberately not in this
  change.
