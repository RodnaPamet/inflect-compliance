# 2026-10-30 — M5: wire and constrain an SAP MCP connection

**Branch:** `feat/sap-connection-constraints` (15 commits) — step M5 of the SAP
agent integration, #3872.

## Design

M5's three constraints are independent invariants on an `mcp-server`
connection, and they turned out to be in three different states when measured.

**Constraint 2 was already done.** Both engines write `EMPTY_CATALOGUE`
(`flue/execute.ts`, `tool-runner/execute.ts` — deploy 2 of the two-deploy enum
had landed under #3869), and `EMPTY_TOOLSET_MESSAGE` already names the seventh
gate as the likeliest cause: *"this agent holds no MCP tool grants… Grant the
tools the workflow declares on the agent's Tools tab"*. Nothing to build; the
work was establishing that rather than assuming it either way.

**Constraint 1 was half done, and the missing half was the dangerous one.**
`dispatchWrite` has always refused a write on a connection at the ladder's
`DISABLED` rung — it handles `DRY_RUN`, `PROPOSE_ONLY` and `AUTOMATIC` and falls
through to a refusal that sends nothing. But the OFFER consulted neither the
write classification nor the rung, so such a tool was advertised to the model
and refused on every call. That is exactly the mismatch the `AUTONOMY` omission
sitting beside it already exists to prevent, one axis over: there the AGENT's
ceiling, here the CONNECTION's rung.

```
adapterFor (external-tools.ts)          offerToolSet (engine-tools/offer-tools.ts)
  connection.mode ─┐                      SCOPE        → omit
  def.annotations ─┴─► externalConnection  AUTONOMY     → omit
                        { declaresWrite,    CONNECTION_READ_ONLY → omit  ← new
                          connectionRefusesWrites,
                          reachesBusinessSystem }
```

Both terms are read ONCE, at invocation-build time, from the same values the
dispatch branches on — so the offer cannot form a different opinion about
whether a tool is a write or whether its connection takes one.

**Constraint 3 needed a gate, and its flag already existed.** J4 (#3864) added
`IntegrationConnection.reachesBusinessSystem` explicitly "for the MCP route
(M4/M5) … so that route reuses one flag instead of inventing its own", which is
what M5's "if J4 already added the flag, reuse it" points at. It had no reader
in `src/` until now. What was missing was the decision and the acknowledgement:

```
driver.ts  posturesFor() ── one query, two postures ──► executeFlueRun
             RESIDENCY_SELECT + EXTERNAL_AI_ACK_SELECT        │
                                                              ▼
            offered.externalConnections ──► externalResidencyRefusal()
            providerIdOf(modelSpecifier)         │
            acknowledgement                      ├─ null  → run proceeds
                                                 └─ refusal → failRun(...)
```

The gate sits after the offer and before the first model call, which is the only
correct window: earlier it would judge tools the model cannot reach, later the
transfer it exists to refuse has already happened.

## Files

| File | Role |
| --- | --- |
| `src/lib/integrations/external-write-ladder.ts` | `refusesEveryWrite` — the fourth rung's predicate, completing the partition |
| `src/lib/mcp/tools/types.ts` | `ExternalConnectionFacts` and the optional field on `McpReadTool` |
| `src/lib/mcp/tools/external-tools.ts` | `adapterFor` populates the facts; the dispatch increments the counter |
| `src/lib/agentic/engine-tools/offer-tools.ts` | the `CONNECTION_READ_ONLY` omission; reports `externalConnections` |
| `src/lib/agentic/external-residency-gate.ts` | the pure transfer decision, its select and its mapper |
| `src/lib/agentic/flue/model-selection.ts` | `providerIdOf` — the one definition of a specifier's provider |
| `src/lib/agentic/flue/driver.ts` | reads both postures in one query, hands them down |
| `src/lib/agentic/flue/execute.ts` | calls the gate, settles the run on a refusal |
| `src/app-layer/usecases/tenant-security-settings.ts` | the acknowledgement writer — `admin.manage` AND a person |
| `prisma/migrations/20261030090000_external_ai_business_data_ack/` | two nullable columns and the attribution CHECK |
| `src/lib/observability/integration-metrics.ts` | `agentic.external_tool.call` |
| `docs/runbooks/wiring-an-sap-mcp-connection.md` | the operator runbook |

## Decisions

**A `NULL` business-system flag PROCEEDS.** Everything else in this subsystem
fails closed, and this deliberately does not. Fail-closed is right for
*authority* and wrong for a *claim about the world*: `NULL` is nobody having
reviewed the connection, which is not evidence that it carries an ERP's rows.
Acting on it would refuse nearly every run in the product for a reason about our
own bookkeeping. `=== true`, never truthiness, and the discriminating test sits
beside it — a mixed offered set with one marked connection still refuses.

**The acknowledgement is tenant-wide, not per-connection.** M5's prompt says "a
recorded tenant acknowledgement", and that is the right scope: the decision is
about the DESTINATION — an external model provider — not about which ERP the
rows came from. So it is two columns on `TenantSecuritySettings` beside
`aiResidency`, whose consequence it accepts, rather than a new model. A new ERP
connection is covered by an existing acknowledgement, which is what "tenant
acknowledgement" means.

**Both acknowledgement columns or neither, enforced by a CHECK.** An
acknowledgement nobody can attribute is not one. The usecase always writes both;
the CHECK makes the half-set row unrepresentable, so a future raw UPDATE or a
second writer cannot produce an anonymous consent either. Proven against a real
database rather than argued.

**No foreign key on the acknowledging user id.** `SET NULL` would make an
employee's deletion withdraw the company's consent; `RESTRICT` would block a
GDPR erasure. The hash-chained audit row preserves who it was. This follows the
table's own precedent — `recertificationOwnerUserId` carries no FK either.

**`admin.manage` AND a person.** The route gate matches both siblings on that
row, because this accepts the consequence of the `aiResidency` choice the
sibling PUT writes. The person check lives in the usecase so no other path to
the same columns can bypass it: `*`-scoped API keys exist, and a credential
cannot accept a data transfer on a company's behalf.

**The counter is not tagged by connection, though the prompt asked for that.**
`recordPeerCardCheck` in the same file already states the rule — "the peer id
and the hashes are NOT labels: both are unbounded, and the per-peer record is
the audit row" — and that row already exists for this event:
`recordExternalToolDecision` writes an `AiDecisionLog` per external call
carrying `provider: mcp:<connectionId>` and the same outcome. An id label would
add cardinality across every tenant without adding a fact; a connection NAME
would be worse, being tenant-chosen text able to carry the shape of a customer's
estate into a metrics backend. It carries the two bounded classes the
constraints are about instead.

**A new field on `OfferedToolSet` rather than a defensive default.** Adding
`externalConnections` broke all five suites that mock `flueToolsFor` — 44
failures. Fixed in the mocks, not with a `?? []` at the read site: a default
there would let a future engine that forgot to populate it hand the gate an
empty list, which refuses nothing. A loud break at every mock is the contract
surviving into runtime.

**The migration's timestamp was bumped.** It was authored as `20261029200000`
and main landed `20261029200000_tenant_system_user` at the same instant. Prisma
orders by folder name so both apply deterministically, but two migrations
stamped at the same moment misleads whoever reads the list; it is now
`20261030090000`, which is also when it was really finished.

**Three of this branch's own probes were blind, and mutation found each.** An
anchored `^\s*externalTools[,:]` detector walked past an inline second producer;
an API-key fixture passing `userId: undefined` passed for the wrong reason, the
usecase's separate author guard firing with the same refusal code; and the
gate's WIRING was tolerated being deleted by all twenty-two of its behavioural
tests, because they exercise the pure decision and the stored row and neither of
them is the seam. The third is why
`tests/guards/business-data-transfer-gate-is-wired.ts` exists and why it asserts
the ordering rather than only the call.

## What M5 does not do

It does not supply the SAP-side server. The three read-only SAP tools and their
BTP skillset are step M4 (#3871), which is open; the repository contains
neither. Nothing here calls an SAP API — these are constraints on a connection
whose far end the customer hosts.
