# 2026-09-23 — "Phase 1 ships no new surface", reconciled against what it shipped

**Commit:** `<sha>` test(agentic): pin the agentic API surface population, and reconcile point 01's no-new-surface claim

The Flue integration plan's point 01 closes with *"Nothing else — phase 1 ships
no new surface."* Phase 1 shipped four new routes and two new pages. This note
records what the sentence was protecting against, what arrived anyway, which
bullet compels each arrival, and the ratchet that now makes the claim
falsifiable instead of merely asserted.

It is a RECONCILIATION, not a revert. Nothing enumerated here should be
deleted; every item is load-bearing for a later point.

## The enumeration, re-derived

Phase 1 opens at `41cbdf413` (#2700, 2026-09-20). Measured against
`origin/main` at `518b74d36`:

```
git diff --diff-filter=A --name-only 41cbdf413^..HEAD -- 'src/app/*'
```

Nine added files, five surfaces:

| Surface | Introduced by | Compelled by |
| --- | --- | --- |
| `(app)/agents/runs/[runId]/` — `page.tsx`, `AgentRunDetailClient.tsx`, `loading.tsx` | `530757861` — #2735 | Points **02 / 04 / 05**, all of which say *"per step on the run timeline"*. Four plan bullets name that timeline; none of them can be built against a surface that does not exist. `GET /agent-runs/:id` had served the ordered step ledger since the engine shipped and was read by nothing. |
| `(app)/agents/decisions/` — `page.tsx`, `DecisionsClient.tsx` | `610274e2c` — #2771 | Point **04**, which asks a per-step guard verdict to link to its decision-log row. A link needs a destination. The page's own docstring says so: *"IT IS THE LINK TARGET POINT 4 ASKS FOR"* — `?digest=` is that target. |
| `api/t/[tenantSlug]/agent-proposals/bulk/reject/route.ts` | `323a9ec35` — #2763 | Point **03** — bulk reject on the review queue. |
| `api/t/[tenantSlug]/admin/agent-driver/route.ts` | `0bc9a057c` — #2780 | Point **01**'s own third bullet — the per-tenant driver toggle. The column shipped with a reader, a `@default(STATIC)` and zero write sites; a gate whose customer half cannot be moved through the product is a constant wearing a switch's name. |
| `api/t/[tenantSlug]/admin/identity-joiner-passes/route.ts` + `…/run/route.ts` | `07b64299c` — #2707, `4bca1c9b5` — #2742 | **NOTHING in the Flue plan. These are not agentic surface at all** — they are the JML joiner pass (#2687/#2698), a concurrent and unrelated stream that happens to share the date window. |

**Every agentic item is compelled by a bullet. None is orphaned.** The two
that are compelled by nothing in the plan are also governed by nothing in the
plan: the diff window is a DATE RANGE over the whole repo, and two work
streams were in flight. That is the enumeration's first real defect —
"everything added since `41cbdf413^`" is not the same population as "everything
phase 1 added", and reading the first as the second turns a neighbouring
team's PR into a finding against this one.

**The window is a floor, not a census.** `--diff-filter=A` sees NEW FILES
only. Nine `src/app/**` files were MODIFIED in the same range, and several of
those modifications are themselves new user-facing surface: the driver chip on
`agents/[agentId]/tabs/OverviewTab.tsx` and `agents/runs/AgentRunsClient.tsx`
(#2732 — `c797a034b`, which DOES resolve in this tree), the bulk-reject
selection bar on `agents/proposals/AgentProposalsClient.tsx`, and the decisions
entry in `agents/AgentsViewsMenu.tsx`. A chip added to an existing page is
surface by any reading that would count a page; the added-files filter cannot
see one.

## What the sentence was protecting against, and how to read it now

Point 01 is the seam every other point hangs off. Its own note
(`2026-09-21-static-driver-extraction.md`) states the requirement plainly:
*"It adds no capability and changes no behaviour — that is the whole
requirement."* The sentence is a **scope fence around the extraction**: do not
let a refactor that must be provably behaviour-neutral become the PR that also
ships a feature, because then nothing can be verified by comparing before and
after.

That is a claim about POINT 01's OWN DIFF, and against that reading it is
true — `41cbdf413` and the extraction it precedes add no surface. What it is
not, and was never able to be, is a claim about the phase: points 02–05 are
inside phase 1 and three of them require a run timeline that did not exist.

**Read it as: "point 01 ships no new surface; surface arrives with the point
that needs it."** The audit's internal inconsistency follows directly from the
other reading — one verdict said phase 1 added no new surface while another
verdict's whole subject was a link into `/agents/decisions`, a page phase 1
added. Both verdicts cannot be about the same population.

## The ratchet, and what was already there

The audit also recorded that no ratchet pins the agentic surface population.
That is HALF right, and the half matters, because the two halves fail
differently.

**Pages were already pinned.** `tests/guards/agentic-route-inbound-links.test.ts`
carries an `AGENTIC_ROUTES` registry and a completeness check — a new
`(app)/**` page whose route mentions agents or mcp fails until it is written
down AND linked from somewhere. Verified by mutation: adding
`(app)/agents/zzz-probe/page.tsx` turns that assertion red.

**One nearby ratchet is weaker than it looks, and it is worth knowing why.**
`tests/guards/rq4-1-page-segregation.test.ts` asserts every `page.tsx` is
classified MAIN or SUBPAGE — but `classifyRoute` resolves through
`matchesPattern`, where a `[dynamic]` segment matches ANY segment. So
`/agents/decisions` is "classified" by the pattern `/agents/[agentId]`, and
the probe page above passes that guard untouched. Neither `/agents/decisions`
nor `/agents/reports` appears in `page-segregation.ts`. That is a real gap in
a different guard's reach and is NOT fixed here — it is recorded so the next
reader does not mistake a wildcard match for a registration.

**API routes were pinned by nothing that requires a decision.** A new route
does turn `tests/contracts/api-schemas.test.ts` red — but that is a CHECKSUM,
not a registry. The route walker publishes every route as an `x-stub`
operation, so regenerating `public/openapi.json` clears the red with nobody
having decided that new agentic surface was intended. A checksum notices an
addition; it cannot refuse one.

Measured twice, with two probes, because the first measurement was misleading.
A SLOPPY new route (no `withApiErrorHandling`, no reachable `assertCan*`) turns
three things red — `api-error-wrapper-coverage`, `api-route-has-some-authorization`
and the openapi drift check — which reads like a well-guarded population. A
WELL-FORMED one, copied verbatim from the bulk-reject route so its
authorization and error handling are the real thing, turned exactly ONE red
before this change: the openapi drift check. The other two are hygiene
guardrails that a correctly-written route satisfies by being correctly
written; neither has an opinion about whether the route should exist.

So the addition is `AGENTIC_API_ROUTES` — a written census of the 32 route
files under `src/app/api/` whose path names an agent or mcp — placed in the
SAME FILE as the page registry rather than in a parallel guard, with the
`agent|mcp` needle hoisted to one `IS_AGENTIC` constant both halves read.
Three assertions: every discovered route is registered, every registered route
still exists, and no route is named twice, over a population floor that fails
if the scan ever stops finding anything. With it in place the well-formed
probe reddens TWO things — the registry, and the drift check — and only one of
those can be cleared by a regenerate.

It asserts nothing about this note. A guard that grepped markdown for a
filename would verify mention, not accuracy.

## Files

| File | Role |
| --- | --- |
| `tests/guards/agentic-route-inbound-links.test.ts` | `AGENTIC_API_ROUTES` + the completeness block; `IS_AGENTIC` shared with the page half; `repoRoot()` hoisted to module scope so both blocks use one locally-computed root |
| `docs/implementation-notes/2026-09-23-phase1-surface-reconciliation.md` | this note |

## Decisions

- **Extend the existing registry file, do not add a parallel guard.** The page
  half's completeness check already lives there, the two populations are
  adjacent (a page and the route it calls land in one PR), and the guard-file
  ceiling in `no-epic-named-ratchets.test.ts` was raised twice in five days —
  725 files against a `toBeLessThan(750)`. A second file would have spent
  headroom to say half of what one file says.
- **One needle, `IS_AGENTIC`, read by both halves.** A needle that drifted
  between them would leave a gap exactly where the two meet. Widening scope is
  now one edit that widens both.
- **The needle stays `agent|mcp` rather than growing `flue` / `autonomy`.**
  Matching the page half is the argument; a needle that covers more than the
  registry it feeds invites a population nobody curated. Widen both together
  when a `flue/`-shaped route actually exists.
- **`admin/agent-driver` is registered with a note that NO PAGE CALLS IT.**
  Grepping `src/app/t/` for the path returns nothing; the route is reachable
  by an OWNER with curl and by nothing else. That is API surface without a
  user-facing page — a weaker version of the unreachability
  `agentic-route-inbound-links.test.ts` exists for. It is recorded rather than
  enforced, because requiring an in-repo caller for every agentic API route is
  a different guard with a different exemption set (the public partner surface
  legitimately has none), and adding it here would redden main.
- **The JML joiner routes are NOT in the registry.** They are not agentic
  surface, and admitting them to make the enumeration tidy would make the
  registry mean "things added in September" instead of "the agentic surface".
- **Nothing is reverted.** Every agentic item is compelled by a later bullet,
  and deleting any of them would break the point that needs it.
