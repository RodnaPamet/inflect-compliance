# 2026-09-05 — Deny-by-default at the MCP tool registry, and the third-party agent's supplier

**Commit:** `<pending>` feat(agentic): pin the loadable tool set to the invocation; close the supplier-attribution seam

ASI04 says a third-party MCP server is an unvetted dependency. Two halves of that
in this codebase: which tools an agent may LOAD, and which SUPPLIER a third-party
agent is attributable to.

## Design

### 1. The tool manifest — where "the session" is

There is no long-lived MCP session object in this codebase. An `McpInvocation`
IS the session: `buildMcpInvocation` assembles one per HTTP request to
`/api/mcp`, and `resolveMcpInvocation` assembles one per workflow-run SEGMENT,
which then drives every step of that segment. Every authorization term an
invocation carries — grants, in-force policy card, autonomy ceiling — is read
once, at assembly. So "mid-session" means exactly: after an invocation was
assembled and before it stops making calls. For a direct tool call that is one
request; for the workflow engine it is a whole run segment.

Two gaps existed against that model.

**The catalogue skipped the card.** `listReadToolDescriptors` filtered on the
agent's grants and the acting context's permissions;
`listProposeToolDescriptors` filtered on the grants and the `mcp:propose`
capability. Neither applied the policy card's `permittedTools`. `tools/call`
did (step 5 of `authorizeToolCall`), so such a tool always 403'd — but an agent
plans against `tools/list`, so every call it made against the difference wrote an
`AUTHZ_DENIED` row. That row is the primary rogue-agent signal, and
`listReadToolDescriptors`'s own docstring already names "manufacture denials
until an operator ignores them" as the reason the filter exists. The card term
was missing from the filter that was built to prevent exactly this.

**Resolution enumerated the live registry.** `runReadTool` did
`READ_TOOLS.find(t => t.name === name)`, `runProposeTool` the same over
`PROPOSE_TOOLS`. Every other authorization input is pinned onto the invocation;
the set of names the process would resolve was not. A name entering the registry
by any route — including one this build does not anticipate — became resolvable
to an invocation that was never authorized against it.

The fix is a pin, not a detector. `McpInvocation` gains `offeredTools`, a COPY of
the catalogue taken at assembly, and `resolveOfferedTool` is the one door between
a tool NAME and a tool OBJECT. A name absent from that snapshot does not resolve,
whatever the registry now holds; nothing has to notice the addition for the
refusal to happen, which is the only version of the property that survives a
mechanism nobody predicted.

```
buildMcpInvocation
  ├─ grantedTools     RegisteredAgentTool        (deny-by-default, null = no agent)
  ├─ policyCard       AgentPolicyCardVersion     (null = no card)
  └─ offeredTools     [...MCP_TOOL_NAMES]        ← NEW: the catalogue snapshot
                              │
        ToolManifest = { offered, grantedTools, permittedTools }
                              │
        ┌─────────────────────┴──────────────────────┐
   toolIsLoadable                              toolWasOffered
   (tools/list filter)                         (resolveOfferedTool)
```

`offered` is an INPUT rather than a module import, which is what makes the
property expressible in a test — "a tool the registry has and this manifest does
not" — and what a future MCP CLIENT integration (a third-party server's
catalogue, fetched once) would inherit for free.

`null` contributes NO term; an empty array/set forbids everything. Those are not
collapsed in either direction: an absent card must not take a working agent dark,
and an empty grant list must not read as "unset, so allow".

`tool_not_offered` is its own `McpDenialReason` rather than folded into
`tool_not_granted`, because the two send an operator to different places —
"grant it in the register" versus "the authority this run holds was fixed before
that tool existed; start a new run". The refusal carries a DIGEST of the loadable
set and a COUNT, never the list; the successful-invocation row carries the same
digest, so two calls in one run reporting different fingerprints is the rug-pull
signal.

`resolveOfferedTool` runs ahead of audience and liveness, a deliberate exception
to `authorize.ts`'s "credential checks first" ordering: it needs no credential
and no query, and the credential was already validated at the HTTP boundary
before any of this ran.

### 2. The third-party agent's supplier — what already existed

Almost all of it. `RegisteredAgent.provenance` + `vendorId`, the migration's
`RegisteredAgent_thirdParty_requires_vendor_check` CHECK, an
`@@index([tenantId, vendorId])`, a shared Zod refinement on all three input
schemas, and `assertVendorInTenant` in the usecase. Covered by
`tests/unit/agent-registry-input-rules.test.ts` (schema layer, asserts the issue
PATH) and `tests/integration/agent-registry-isolation.test.ts` (the CHECK, against
a raw CREATE; plus cross-tenant vendors twice). None of that was rebuilt.

**The seam between the two enforcements was a live defect.** The schema
refinement judges the PAYLOAD; the CHECK judges the RESULTING ROW.
`updateRegisteredAgent(ctx, id, { vendorId: null })` names no provenance, so
`isUnattributedThirdParty` answered "no" and the edit passed validation — onto a
row that is THIRD_PARTY. Enforcement fell through to Postgres, which has no idea
it is answering a validation question: the create path returns a 400 naming
`vendorId`, and this path returned a raw constraint violation (a 500).
`updateRegisteredAgent` now applies the same predicate to the MERGE — the payload
laid over the live row, read inside the transaction the write lands in — so the
DDL goes back to being the backstop it was written as rather than the
enforcement. `undefined` (absent from the payload) and `null` (clear it) are kept
apart in the merge; `??` would have conflated them.

**There is no MCP server or connection RECORD to extend this to.** This product
IS the MCP server; agents connect inbound to `/api/mcp`; nothing in
`prisma/schema/**` holds a remote server URL, transport or connection target
(`IntegrationConnection` is SaaS-connector plumbing — Okta, Google, SharePoint —
with no MCP concept). The nearest thing to a per-connection record is
`TenantApiKey`, the credential an agent authenticates with, and it already
carries `agentId`. So a third-party CONNECTION is traceable to a supplier
transitively, in two hops, and the linkage test pins that the chain resolves
rather than inventing a parallel record to hold a fact the schema already holds.

## Files

| File | Role |
| --- | --- |
| `src/lib/mcp/tool-manifest.ts` | NEW. The manifest vocabulary — `toolWasOffered`, `toolIsLoadable`, `loadableTools`, `toolManifestDigest`. A leaf: no imports but `node:crypto`, so it cannot cycle with `authorize.ts`. |
| `src/lib/mcp/authorize.ts` | `offeredTools` on `McpInvocation`; `tool_not_offered` denial reason; the three adapters `toolManifestOf` / `isToolLoadable` / `resolveOfferedTool`. |
| `src/lib/mcp/auth.ts` | `buildMcpInvocation` snapshots `[...MCP_TOOL_NAMES]` onto the invocation. |
| `src/lib/mcp/tools/registry.ts` | `tools/list` filters on `isToolLoadable` (card included); `runReadTool` loads through `resolveOfferedTool`; the invocation audit row carries the manifest digest. |
| `src/lib/mcp/tools/propose-tools.ts` | Same two changes for the propose surface. |
| `src/app-layer/schemas/agent-registry.schemas.ts` | `isUnattributedThirdParty` + `THIRD_PARTY_VENDOR_MESSAGE` exported — one predicate, one wording, two scopes (payload and merged row). |
| `src/app-layer/usecases/agent-registry.ts` | `updateRegisteredAgent` evaluates the merged attribution against the live row, inside the transaction. |
| `src/app-layer/repositories/RegisteredAgentRepository.ts` | `getScoringState` also selects `vendorId` — the merge needs both halves of the row it is about to become. |

## Decisions

- **The manifest is a DERIVATION, not a fourth policy.** `toolIsLoadable` is
  `offered ∧ granted ∧ permitted-by-card` over state the invocation already
  pins. `authorizeToolCall` still re-checks the grant and the card SEPARATELY at
  call time, because each refusal has to name its own rule to an operator, and
  because the gate knows three things the set cannot — the data rung a call
  reaches depends on its arguments, and both budgets depend on what came before.
  The set exists for the two callers that need a SET rather than a verdict.
- **The mid-session property is stated as "resolution enumerates the manifest",
  not as a detection.** A detector for "a tool arrived" has to be right about the
  arrival mechanism. A pin does not: the refusal is the default, and a mechanism
  nobody predicted produces a name the snapshot does not contain, which is
  already refused.
- **`resolveOfferedTool` returns `null` for a name this build never had**, and
  the caller turns that into `MethodNotFound`. An unknown name is a protocol
  error, not a denied access attempt; auditing it would let any caller fill the
  rogue-agent trail with typos.
- **The digest is a fingerprint, not a list.** An audit row answers "same or
  different" about the loadable set; it is not a place to accumulate payload.
  Sorted before hashing, so it is a property of the SET and does not move when a
  registry declaration is reordered.
- **The supplier fix moved enforcement UP, not away.** The CHECK constraint is
  untouched and still refuses a raw write that goes round the usecase — including
  a `Vendor` hard-delete, where `ON DELETE SET NULL` would null a column the
  CHECK forbids to be null, so Postgres refuses the DELETE. That composition is
  what makes a third-party agent permanently attributable, and it was written by
  two independent clauses, so it is pinned rather than assumed.
- **No new model, no enum, no migration.** The scope's model/RLS/isolation rules
  did not fire because nothing new is persisted: the manifest is per-request
  state, and the supplier rule is a check over columns that already exist.
