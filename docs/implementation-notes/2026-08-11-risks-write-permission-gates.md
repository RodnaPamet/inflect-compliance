# 2026-08-11 — Risks: write controls now follow the server's own predicate

Follow-up to `2026-08-11-risks-write-failure-surfaces.md`. That change made
failed writes visible; this one stops offering the writes that were never going
to succeed.

## What was actually wrong

Auditing the Risks surface for permission gates turned up five pages with **no
gate at all**. Every write behind them asserts server-side, so for a READER or
AUDITOR the entire editing surface was decorative — each click a guaranteed 403.
Until #1855 those 403s were also silent, which is how it survived.

| page | control | server assertion |
|---|---|---|
| `hierarchy` | add / rename / delete node, link / unlink risk | `assertCanWrite` |
| `kri` | create, record reading, edit, activate, delete | `assertCanWrite` |
| `loss-events` | record | `assertCanWrite` |
| `loss-events` | remove | **`assertCanAdmin`** |
| `correlations` | cell edit, apply suggestion | `assertCanWrite` |
| `scenarios` | create, clone, archive, simulate | `assertCanWrite` |
| `[riskId]/FairAnalysisPanel` | save | `assertCanWrite` |
| `ai` | dismiss | `assertCanWrite` |

The `ai` page is the interesting near-miss: Generate and Apply were already
gated, Dismiss was not. A page can be 90% gated and still hand a reader a
button.

## Design

**Gate on the same flag the usecase reads.** Every gate here is
`useTenantContext().permissions.canWrite` / `.canAdmin` — the coarse
`RequestContext.permissions` the `assertCan*` helpers actually test — not an
`appPermissions` sub-key.

That distinction has teeth. `RequirePermission resource="risks" action="create"`
reads the granular `PermissionSet`, which is custom-role–aware. For the five
built-in roles the two agree, so nothing is broken today. But a custom role with
`risks.create: true` and `canWrite: false` would be shown a control the server
refuses — reintroducing the exact bug, through the mechanism built to prevent
it. Mirroring the server predicate makes the two impossible to diverge.

The existing `RequirePermission` gates on `ai` and `reports` are left alone.
They are not wrong, and rewriting working authorization was not worth bundling
into this change; the new gates simply do not add more of them.

**Hide, don't disable.** This matches `RisksClient`, which renders its New Risk
button inside `permissions.canWrite && (…)`. A disabled control still advertises
a capability the user does not have.

**Two deliberate non-gates.**

- `dashboard/MonteCarloPanel` POSTs to `/risks/simulate`, but `runSimulation`
  asserts **`canRead`** — running a simulation is a read that happens to be
  expensive. Gating it would remove a capability every member legitimately has.
- `correlations` Auto-suggest calls `suggestCorrelations`, also `canRead`. It
  stays available; only Apply and the cell editor are gated. The
  "click a cell to edit" hint is hidden alongside them — telling a reader to
  click inert cells is worse than saying nothing.

**FAIR panel: inputs stay live, Save does not.** Exploring what a different TEF
or loss magnitude would do to the distribution is legitimate read-only work, and
disabling twenty controls to prevent it would cost more than it protects. The
Save button is replaced by a notice that says the exploration is local.

## Files

| File | Role |
|---|---|
| `risks/hierarchy/page.tsx` | node writes + link/unlink gated; `TreeRow` takes `canWrite` and drops its row actions |
| `risks/kri/page.tsx` | create card, per-card reading input, lifecycle actions |
| `risks/loss-events/page.tsx` | record → `canWrite`; remove → `canAdmin` |
| `risks/correlations/page.tsx` | cell editor + Apply + the click hint; Auto-suggest deliberately left open |
| `risks/scenarios/page.tsx` | create card + per-row simulate/clone/archive |
| `risks/[riskId]/FairAnalysisPanel.tsx` | Save → read-only notice |
| `risks/ai/page.tsx` | the one ungated action in an otherwise-gated page |
| `messages/{en,bg}.json` | `risks.fair.readOnlyNotice` |
| `tests/rendered/risk-write-permission-gates.test.tsx` | the lock |

## Decisions

- **Rendered test, not a structural one.** The flags are read through a hook, so
  no import graph, type check or source scan can see a gate that reads the wrong
  predicate — or one that was never added. The test mounts each page under a
  mocked context and asserts the control's presence for BOTH a reader and a
  writer. The positive half is load-bearing: a gate that hides the control from
  everyone would sail through a reader-only assertion.
- **Loss events gets three roles, not two.** READER sees neither control, EDITOR
  sees Record but not Remove, ADMIN sees both. The EDITOR row is the assertion
  that fails if someone later "simplifies" the two flags into one — and the
  ADMIN row is what stops the two negatives from passing vacuously because the
  list failed to render.
- **The test's fetch mock routes bodies by path.** A single merged blob is
  tempting and wrong here: `loss-events/aggregate` reads `agg.byYear.length`
  with the optional chain on `agg` only, so a body missing that key throws
  during render and the permission assertion fails for an unrelated reason.
