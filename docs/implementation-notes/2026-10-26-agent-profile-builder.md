# 2026-10-26 — Agent profile builder: the Behaviour tab (Claude agents 1b)

**Commit:** `<sha> feat(agentic): a Behaviour tab to write, review and approve an agent's profile (Claude agents 1b)`

Step 1b of the roadmap in `docs/claude-agent-sdk-design.md` (#4144). A tenant
can now write, submit, review and approve an agent's profile in the product,
with no CLI and no code. Step 1a's rules hold every act; the tab only decides
what is worth offering. The surface stays behind `AGENT_PROFILES`, and no engine
runs a profile until Phase 2.

## Design

```
page.tsx ──agentProfilesOn()──▶ AgentDetailClient (profilesEnabled)
                                  └─ tab "behaviour" (disabled without admin.agent_registry)
                                       └─ BehaviourTab ── GET …/profile ──▶ getAgentProfile
                                            ├─ In force   (APPROVED, read-only, Test run disabled)
                                            ├─ Open       (DRAFT: Submit · SUBMITTED: diff, Approve, Reject)
                                            ├─ History    (status, author, decider, hash, reason)
                                            ├─ BehaviourEditorSheet ── POST …/profile | …/profile/versions
                                            └─ BehaviourRejectModal ── POST …/versions/:n/reject { reason }
```

The read was reshaped for the page rather than the page for the read:

- An agent with no profile answers `profile: null`. It used to refuse
  `PROFILE_NOT_FOUND`, which would have made the first version unwritable from
  the page that writes it.
- `options` is the agent's current grants and mountable skills, from the same
  predicates the save checks.
- Each version carries `canDecide`, computed by the same rule the usecase
  enforces.
- People are labels from this tenant's memberships, never user ids.
- `testRun` says whether a test run can start, and why not.

The rejection reason needed a column. Step 1a recorded who rejected a version
and when, but not why. The migration
`20261026150000_agent_profile_rejection_reason` adds it, encrypted, and replaces
the lifecycle function in place. The reason is written only in the move from
SUBMITTED to REJECTED, required there, and frozen after, with the same re-wrap
exception as `instructions`.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261026150000_agent_profile_rejection_reason/migration.sql` | `rejectionReason`, its CHECK, and the lifecycle trigger with the reason's rules |
| `prisma/schema/agentic.prisma` | the column |
| `src/lib/security/encrypted-fields.ts` | `rejectionReason` joins `instructions` in the manifest |
| `src/lib/agentic/agent-profile.ts` | `PROFILE_REJECTION_REASON_MAX_CHARS` |
| `src/app-layer/schemas/agent-profile.schemas.ts` | `RejectAgentProfileVersionSchema` |
| `src/app-layer/usecases/agent-profiles.ts` | reject takes a reason; the builder-shaped read |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/profile/versions/[version]/reject/route.ts` | parses the reason |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/page.tsx` | passes the flag |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient.tsx` | the tab, only while the flag is on |
| `…/[agentId]/tabs/BehaviourTab.tsx` | in force, open, history, Test run |
| `…/[agentId]/tabs/BehaviourEditorSheet.tsx` | the editor |
| `…/[agentId]/tabs/BehaviourRejectModal.tsx` | reject with a reason |
| `…/[agentId]/tabs/behaviour-types.ts` | the client copy of the view |
| `…/[agentId]/tabs/types.ts` | `BehaviourTabProps` |
| `messages/en.json`, `messages/bg.json` | `agents.behaviour.*`, `admin.agentDetail.tabBehaviour` |
| `.env.e2e.example` | `AGENT_PROFILES=1`, so the E2E environment has the tab |
| `tests/e2e/agent-detail.spec.ts` | the tab list gains Behaviour |

## Decisions

- **Test run has one state in this step.** A test run needs a start route that
  binds the agent, because a browser session carries none. It also needs
  admission of a SUBMITTED version under the `TEST_RUN` trigger. Neither can be
  exercised while no engine runs a profile. So `testRun` is typed
  `{ available: false; reason: 'NO_ENGINE_RUNS_PROFILES' }`, the button has no
  action, and the enabled state, the route and the action are carried to Step 2c
  in `docs/claude-tool-runner-design.md`. A view that could say
  `available: true` with no action behind it would offer a button that does
  nothing.
- **The reason names the setting:** "Admin → AI features → Agent engines". The
  setting lives there, though no engine it offers runs profiles yet, and the
  sentence says so.
- **The editor's actions sit at the end of the Sheet body.** A footer's last
  action must be a primary (`modal-action-order`), and the product-wide primary
  ceiling has no slot (`primary-secondary-ratio`). The tenant-skill sheet set
  the precedent. Approve is secondary for the same reason, as the tenant-skill
  and parameter-set approvals are. Reject's confirm is `destructive`, the last
  action of its dialog.
- **A tool the starting version named and the agent has lost is named, not
  dropped.** The editor starts from the open version, else the one in force.
  Anything it can no longer offer is listed in a warning, so an edit never
  silently narrows what the author believes they kept.
- **The editor says what saving retires.** One version is open at a time, so
  saving a new draft retires a version waiting for review and takes it out of
  the reviewer's queue. The warning says so before the save.
- **A retired agent's tab offers only Reject.** The usecase refuses a new
  version, a submission and an approval for a retired agent. Reject puts
  nothing in force, so it stays.
- **No Retire control.** The prompt does not ask for one, and an edit already
  retires the open version. Retiring the version in force stays an API act.
- **The E2E's second person joins by invite.** An isolated tenant has one
  OWNER. The reviewer registers, is invited as ADMIN, and redeems by signing in,
  the same mechanics as `invite-flow.spec.ts`. The approval is then asserted on
  the audit log page, by the reviewer's name.
