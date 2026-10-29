# 2026-10-29 — Agent run and agent proposal routes take their pages' gate

**Commit:** `fix(agentic): gate the agent run and proposal routes as their pages are gated`

## Design

The runs, run detail and proposals pages render only for
`mayReadAgentActivity` — `admin.view` OR the inventory view key
`admin.agent_registry_view` (#3710) — and enable Start, Resume, Abort, Approve
and Reject on the role-tier write (`canWrite`). The API routes behind them had
only their usecases' coarse asserts, so the API admitted more than the pages:

| route | before | after |
| --- | --- | --- |
| `GET /agent-runs`, `GET /agent-runs/:id`, `GET /agent-runs/:id/steps`, `GET /agent-proposals` | `assertCanRead` (every role) | `requirePermission({ keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' })` |
| `POST /agent-runs/:id/resume`, `/abort`, `POST /agent-proposals/:id/approve`, `/reject`, `/bulk/reject` | `assertCanWrite` (OWNER, ADMIN, EDITOR) | the same `requirePermission`, then the unchanged `assertCanWrite` |
| `POST /agent-runs` | session: `assertCanWrite`; key: `mcp:orchestrate` | session: the same pair as the other writes; key: unchanged |

So the API refuses exactly whom the page refuses, and a refusal at the route now
writes `AUTHZ_DENIED`. The usecases are unchanged: jobs, the A2A inbound path,
the interactive "ask" path and the recertification pack all call
`startWorkflowRun` directly, never through these routes, and keep the asserts
they had.

`GET /agent-proposals` also stops returning `payloadJson`. The proposals page
and the run checkpoint read never send it to a browser (a reviewer is shown a
server-computed diff, not the blob); the route now projects named fields, every
column but that one, so a later column is not published by accident.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/agent-runs/**/route.ts` | list, start, run, steps, resume, abort gated; checkpoint docblock updated |
| `src/app/api/t/[tenantSlug]/agent-proposals/route.ts`, `[id]/approve`, `[id]/reject`, `bulk/reject` | gated; the list projects without `payloadJson` |
| `src/lib/security/route-permissions.ts` | one rule per route, recording the gate |
| `tests/guardrails/api-permission-coverage.test.ts` | `agent-runs` as a whole privileged root; the three proposal write routes as leaf roots |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/` | the Runs tab is disabled for a reader `GET /agent-runs` refuses |
| `tests/unit/agent-runs-proposals-route-gates.test.ts` | the per-role matrix, the key path, the projection, the map |

## Decisions

- **The read gate is `mayReadAgentActivity`'s two keys, not three.** CLAUDE.md's
  "every inventory read also admits `admin.agent_registry`" can be read as
  making the register key a third read key here. The predicate
  the pages, `/stream` and `/checkpoint` already use does not admit it, and
  `tests/unit/agent-registry-view-key.test.ts` pins that ("the activity read
  (runs, proposals) admits admin.view OR the view key, and not the register
  key"). Adding it would also have put the register key's literal into
  `agent-runs/route.ts`, which brings that file's POST into the view-key census
  and would force POST's gate away from the page's. The one principal the
  choice affects is a custom role holding the register key and neither
  `admin.view` nor the view key; it already could not open the runs or proposals
  page, and the agent detail page now disables its Runs tab for it rather than
  letting the tab fetch and fail. No built-in role is affected either way.
- **`POST /agent-runs` branches on the credential.** A registered agent starts a
  run with a bearer key carrying `mcp:orchestrate` and domain read scopes and no
  admin-console scope (`docs/runbooks/enabling-the-flue-engine.md`; the
  integration suite `agent-registry-enforcement` drives exactly that key). A
  literal `requirePermission` would refuse every such key. So the person's gate
  is applied, through `assertPermission` (the decision `requirePermission`
  delegates to, which writes the same `AUTHZ_DENIED` row), to every context
  whose `ctx.apiKeyId` is unset — only `getTenantCtx`'s key path sets it, so the
  branch fails closed — and a key keeps the scope check the usecase already
  made. Resume and abort have no key carve-out: both are a person's acts, and
  their audit rows record `actorType: 'USER'`.
- **The write gate is two layers, as on the page.** The view key opens the
  surface and confers no write: AUDITOR and AI_ADMIN pass the route and are
  refused by the usecase's `assertCanWrite`, exactly as the page disables their
  buttons. That refusal writes no `AUTHZ_DENIED` row, as before.
- **`agent-proposals/route.ts` is not a privileged root.** The directory also
  holds `compose/` and `sample-audits/`, which were not triaged here, and the
  coverage walker cannot take a single file as a root. The collection GET is
  pinned by the unit test instead.
