# 2026-10-26 — Agent profiles: model, usecases, routes and resolver (Claude agents 1a)

**Commit:** `<sha> feat(agentic): agent profiles, approved by a second person, resolved inside one tenant (Claude agents 1a)`

Step 1a of the roadmap in `docs/claude-agent-sdk-design.md` (#4143). A tenant can
now write what a registered agent should do, have a second person approve it, and
start a run under `agent-profile:<profileId>@v<n>`. Admission refuses that run on
every engine this build has, by owner decision, until Phase 2 gives it one that
renders the instructions.

## Design

```
POST …/admin/agents/:agentId/profile[/versions]       whenAgentProfilesEnabled → requirePermission('admin.agent_registry')
        │
        ▼
usecases/agent-profiles.ts  (the only writer)
  sanitizePlainText → cap → scanSkillText(declaredTools = toolNames)
  toolNames ⊆ RegisteredAgentTool (refuse by name)   skillRefs ⊆ shipped ∪ tenant APPROVED
  DRAFT → SUBMITTED → APPROVED | REJECTED  (decider ≠ author, a person)  → RETIRED
        │                                   pointer AgentProfile.currentApprovedVersion
        ▼
startWorkflowRun(ctx, key)
  resolveRunDefinition(ctx, key)            registry key → unchanged
        agent-profile:<id>@v<n> → APPROVED ∧ in force ∧ caller's tenant ∧ hash recomputed
        → WorkflowDefinition { driver: 'flue', readOnly?, profile: ProfileRunSpec }
  selectRunDriver …
  assertEngineRunsProfiles(chosenDriver)    static → PROFILE_NEEDS_REASONING_ENGINE
                                            !runsProfiles → PROFILE_ENGINE_CANNOT_RUN_PROFILES
  createSealedRun(…, { versionId, instructionsHash })   pin, write-once
```

The database holds what it can below the usecase:
- the CHECK `AgentProfileVersion_not_self_decided`;
- a lifecycle trigger: inserted at DRAFT; text and settings frozen for every role
  apart from the rotation sweeps' ciphertext re-wrap; status one way; stamps
  written once;
- partial unique indexes for one APPROVED and one open version per profile;
- no DELETE for `app_user`;
- the RLS triple on both tables;
- on `WorkflowRun`, a both-or-neither CHECK and a write-once trigger for the
  pin.

At run time an engine narrows its offer through `offerToolSet`'s new
`profileTools`. It offers the profile's tools that the agent still reaches, and
lists each one it lost as `PROFILE_TOOL_NOT_GRANTED`.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma`, `enums.prisma`, `auth.prisma` | `AgentProfile`, `AgentProfileVersion`, two enums, the run pin columns |
| `prisma/migrations/20261026100000_agent_profiles/migration.sql` | tables, CHECKs, partial uniques, triggers, privileges, RLS |
| `src/lib/agentic/agent-profile.ts` | vocabularies, the run key, `runsProfiles`, the flag parser (pure) |
| `src/lib/agentic/agent-profile-flag.ts` | the 404 gate every profile route wears |
| `src/app-layer/usecases/agent-profiles.ts` | create, edit, submit, approve, reject, retire, read |
| `src/app-layer/usecases/agent-profile-runs.ts` | `resolveRunDefinition`, `assertEngineRunsProfiles` |
| `src/app-layer/usecases/workflow-runs.ts` | the resolver call, the engine refusal, the pin |
| `src/lib/agentic/engine-tools/offer-tools.ts` | `profileTools` and `PROFILE_TOOL_NOT_GRANTED` |
| `src/lib/agentic/workflow-types.ts` | `WorkflowDefinition.profile`, `ProfileRunSpec` |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/profile/**` | six routes |
| `src/lib/security/encrypted-fields.ts`, `route-permissions.ts`, `src/env.ts` | the manifest entry, the rule, `AGENT_PROFILES` |

## Decisions

- **No engine runs a profile in 1a** (owner, 2026-10-26, decision 7).
  - **Why:** Flue's prompt is the definition's description and steps. So
    admitting a profile on Flue would run it while ignoring its instructions, a
    silent degrade.
  - **How:** a per-engine `runsProfiles` record, false everywhere. The exit
    condition "admits or refuses with a named reason" is met by refusal. The
    pin is proved with the record mocked true for one test.
- **The approver is a person.** Approval and rejection refuse an API-key caller
  (`DECIDER_NOT_A_PERSON`) as well as the author. The CHECK covers rejection
  too: the prompt's CHECK is on `decidedByUserId`, and both decisions write it.
  The author withdraws their own submission by retiring it.
- **The hash is recomputed, not trusted.** The encrypted column cannot be
  frozen against the DEK rotation sweep, which re-encrypts as the table owner.
  So the trigger admits ciphertext to `v2:` ciphertext with every other column
  unchanged.
  - **The test:** copying another version's ciphertext through that exception
    passes the trigger and fails the resolver (`PROFILE_HASH_MISMATCH`).
  - **Why it matters:** the recompute is the freeze for that column.
- **Tools are checked against grants at save AND at approval.** A grant revoked
  while a version waits is refused at approval by name, and at run time the
  intersection narrows and records the omission. Nothing fails open.
- **The text scan's `declaredTools` is the profile's own tool list.** Its
  `skill.undeclared_tool` rule then refuses instructions that steer the model
  toward a tool the profile does not offer.
- **No new permission key** (decision 3). `admin.agent_registry` authors and
  approves. Four-eyes is a person rule, not a key split, as declined in the
  decision.
- **`allowedTriggers` is stored and not yet enforced.**
  - **Why:** in 1a nothing starts a profile run past admission.
  - **Who enforces it:** each trigger site checks its own value. The Ask page
    and Test run in 1b, automation in Phase 2.
- **Resume and settlement still read the registry.** No profile run row can
  exist until an engine runs profiles. Step 2b's prompt now carries the
  obligation to route them through the resolver, render the instructions and
  pass `profileTools`.
