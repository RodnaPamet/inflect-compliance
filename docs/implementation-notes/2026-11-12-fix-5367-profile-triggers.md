# 2026-11-12 — A profile run names its trigger, on every start path (#5367)

## Design

`AgentProfileVersion.allowedTriggers` (`ASK`, `AUTOMATION`, `TEST_RUN`) is a
version's own statement of what may start it. `resolveRunDefinition`
(`src/app-layer/usecases/agent-profile-runs.ts`) checked it only
`if (opts.trigger && …)`, and only `startAgentProfileTestRun` passed a
trigger. Every other path that can name an `agent-profile:<id>@v<n>` key was
admitted unchecked, so a version allowing only `TEST_RUN` ran from:

| Path | Who | Trigger now |
| --- | --- | --- |
| `agent-invoke-dispatch` (an `INVOKE_AGENT` rule; `workflowKey` is any string in `automation.schemas.ts`) | a job, as the rule's owner with the agent bound | `AUTOMATION` |
| `startInteractiveRun` (the Ask path) | a person, with the designated agent bound | `ASK` |
| `startAgentProfileTestRun` (Behaviour tab) | a person | `TEST_RUN` (unchanged) |
| `POST /agent-runs` | a person, or a key with `mcp:orchestrate` | none: refused |

Paths that could not reach a profile key and are unchanged: the inbound A2A
start resolves its key through the registry (`getWorkflowDefinition`), which
knows no profile key, and the audit-narrative and agent-recertification starts
use fixed registered keys.

Admission now refuses a profile key whose start names no trigger
(`PROFILE_TRIGGER_REQUIRED`), after the flag, key-shape and Test-run-key checks
and before the version is read. It refuses one whose trigger the version does
not allow (`PROFILE_TRIGGER_NOT_ALLOWED`, the existing code), with no
`opts.trigger &&` escape. A registered workflow key ignores the trigger as
before.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/agent-profile-runs.ts` | requires a trigger for a profile key; unconditional allowed-trigger check |
| `src/app-layer/jobs/agent-invoke-dispatch.ts` | passes `AUTOMATION` |
| `src/app-layer/usecases/interactive-agent-runs.ts` | passes `ASK` |
| `src/app-layer/usecases/workflow-runs.ts` | `profileTrigger` option docstring only |
| `src/app/api/t/[tenantSlug]/agent-runs/route.ts` | docstring: the route starts no profile |
| `CLAUDE.md`, `docs/claude-agent-sdk-design.md` | state the admission rule |

## Decisions

- **`POST /agent-runs` is no trigger.** The enum's three values are the Ask page,
  an automation rule and the Test run, and the enum's own docstring and the
  design document name exactly those. A manual start by a person from the runs
  page, or by an orchestrating key, is none of them, so no version could allow
  it. Counting it as one (an API start as `AUTOMATION`, say) would let a version
  that allows that trigger be started by a caller it never named. Refusing is the
  fail-closed reading. If the owner wants a direct start, it is a new trigger
  value (a CHECK change), and the route names it.
- **The refusal precedes the version read.** It is about the request, not the
  version, so it costs no query and says nothing about whether the profile
  exists.
- **The dispatcher still throws on an admission refusal**, as it already did for
  every other profile refusal (`PROFILE_VERSION_NOT_APPROVED` and so on). It
  was not changed into a named dispatcher refusal, to keep the fix to admission.
- **No default trigger** in `startWorkflowRun`. A default is how the check came
  to be skipped: every caller that omitted it was admitted.
