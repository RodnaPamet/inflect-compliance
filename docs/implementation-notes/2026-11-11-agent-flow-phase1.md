# 2026-11-11 — The flow inside the profile version (agent-flow canvas, Phase 1)

**Commit:** `wf/agent-flow-phase1` — feat(agentic): a drawn flow as data on the agent profile version

Phase 1 of `docs/ai-architecture/langflow.md`. No UI: the canvas (Phase 3)
will write what this phase stores.

## Design

```
request body ── AgentProfileVersionSchema (flow: unknown, toolNames XOR flow)
     │
     ▼
agent-profiles.ts (the ONLY writer)
  prepareFlow: checkAgentFlow → sanitizePlainText(labels) → checkAgentFlow again
               → refuse a propose step in an ANSWER_ONLY version
  toolNames  = flowToolNames(flow)           (derived, never entered)
  text scan  over instructions + labels
  flowJson   = serializeAgentFlow(flow)      (canonical JSON; encrypted, Epic B)
  hash       = profileContentHash(instructions, flowJson)
  grants     : assertToolsGranted(toolNames) (unchanged, so it is the flow's check)
  subagents  : APPROVED profile, this tenant, not itself
     │                         approve: re-hash, re-parse, tools agree,
     ▼                                  re-scan, grants, subagents again
AgentProfileVersion.flowJson ── frozen by agent_profile_version_lifecycle()
     │
     ▼
agent-profile-runs.ts  resolve: recompute content hash (PROFILE_HASH_MISMATCH)
                       parse + tools agree, or the version runs nothing
                       compileFlow → ProfileRunSpec.flow, readOnly if no propose
     │
     ▼
flue/run-message.ts    lists the flow's steps whole, in topological order
```

`src/lib/agentic/agent-flow.ts` is pure (zod and the leaf tool catalogue), so
Phase 3's canvas can hold the same schema the server enforces.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-flow.ts` | Schema, graph checks with named refusals, canonical form, `compileFlow`, derived tools |
| `prisma/schema/agentic.prisma` | `AgentProfileVersion.flowJson String?` |
| `prisma/migrations/20261112100000_agent_profile_flow/` | Column, non-empty CHECK, lifecycle function with `flowJson` frozen and in the re-wrap exception |
| `src/lib/security/encrypted-fields.ts` | `flowJson` joins the manifest |
| `src/app-layer/schemas/agent-profile.schemas.ts` | `flow` accepted; `toolNames` only without one |
| `src/app-layer/usecases/agent-profiles.ts` | Flow preparation, content hash, subagent check, approval re-checks, read view |
| `src/app-layer/usecases/agent-profile-runs.ts` | Content hash at the resolver and the worker, compiled flow, read-only |
| `src/lib/agentic/workflow-types.ts` | `ProfileRunSpec.flow` |
| `src/lib/agentic/flue/run-message.ts` | Renders a flow's steps |

## Decisions

- **The hash kept its column.** `instructionsHash` is now the version's content
  hash: with no flow it is `sha256(instructions)`, byte for byte as before, so
  every stored version, every approval naming a hash and every
  `WorkflowRun.profileInstructionsHash` pin still verifies, and no backfill was
  needed. With a flow it is `sha256(JSON.stringify([domain, instructions,
  flowJson]))`. Renaming the column would have been a two-deploy change for no
  safety gain.
- **The flow is encrypted TEXT, not JSONB.** The Epic B middleware encrypts
  strings only, and labels are business content. The column is therefore
  ciphertext in the database, so the content hash is computed in the writer
  and recomputed by the resolver, never in SQL.
- **The trigger freezes the column, and admits the re-wrap.** The tenant-DEK and
  master-KEK sweeps rewrite every manifest ciphertext in place, so ciphertext to
  `v2:` ciphertext with every other column unchanged is admitted for `flowJson`
  as for `instructions`. A ciphertext swapped in under that exception is caught
  by the recomputed hash (proved in `tests/integration/agent-profile-flow.test.ts`).
- **One list of tools.** With a flow the request may not carry `toolNames`
  (schema, `FLOW_TOOLS_ARE_DERIVED`). The writer stores the derived list; the
  approval and the resolver both refuse a row whose stored list is not what the
  flow derives (`FLOW_TOOLS_DIVERGED`, or no definition at all).
- **No element the engine would ignore.** No `checkpoint` kind (D-L2-2,
  `FLOW_CHECKPOINT_UNENFORCED`); a step's tool must be of its kind
  (`FLOW_TOOL_KIND_MISMATCH`, an unknown name counts as propose, so it is never
  waved through as a read); a propose step in an `ANSWER_ONLY` version is
  refused (`FLOW_OUTPUT_KIND_CONFLICT`).
- **Labels are scanned.** They reach the run message beside the instructions,
  so the skill text scan reads them together.
- **The run message lists a flow whole.** A reasoning engine's `fromSeq` counts
  ledger steps, not specification steps, so slicing a flow by it would drop
  steps not yet covered. Every definition without a flow renders byte for byte
  as before, so no decision digest moves.
- **Subagents.** `profileRef` is an `AgentProfile` id, read through the tenant
  filter and RLS, so another tenant's profile is indistinguishable from none.
  Self-reference is refused. A loop through another profile's flow is not
  detected yet: nothing executes a `subagent` node before Phase 5, where the
  delegation gate is the enforcement.
- **No new route, no new permission.** The two version routes already parse the
  schema and call the usecase; `admin.agent_registry`, the audit rows and the
  404 when profiles are switched off are unchanged. Audit rows carry the node
  count, never labels.

## Risk assessment (SIGNIFICANT: schema migration)

- **Rolling deploy.** One nullable column the previous image never reads, a
  CHECK every existing row (NULL) satisfies, and `CREATE OR REPLACE` of the
  lifecycle function. An old container writes no `flowJson`: its inserts store
  NULL and its updates leave the column unchanged, so nothing it does is
  refused. A new container reading a row an old one wrote sees NULL, which is
  "no flow".
- **Encryption.** A new manifest column is picked up by both rotation sweeps,
  which read the manifest. The fan-out encrypt path matches field names across
  models; no other model has a `flowJson` field.
- **Exposure.** The whole surface sits behind `AGENT_PROFILES`, off by default.
  A flow can only narrow: its tools are a subset of the grants at save, at
  approval and at run time, and it can make a run read-only, never the reverse.
- **Blast radius of a bug.** A malformed stored flow makes that one version
  unrunnable (fails closed), never runnable without its flow.

## Rollback plan

- **Application:** redeploy the prior image. It ignores `flowJson`; a version
  that carries a flow would then run as its instructions plus its derived
  `toolNames`, with no step list in the run message, and its hash would no
  longer verify under the old `sha256(instructions)` rule, so the old resolver
  refuses it (`PROFILE_HASH_MISMATCH`). That is fail-closed. Retire any flow
  version before rolling back if it must keep running.
- **Database:** forward-fix only, per `docs/change-management-policy.md`. The
  column, CHECK and function are additive and harmless to the old image, so no
  down-migration is needed. If the function itself were faulty, a follow-up
  migration restores the 20261026150000 body with `CREATE OR REPLACE`.
