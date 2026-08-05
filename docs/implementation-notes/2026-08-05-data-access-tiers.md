# 2026-08-05 — Four data-access tiers, resolved by measurement

**Commit:** `<pending> refactor(hooks): delete the dead data-access tier, make the docblocks true`

## What is actually true

| tier | files |
| --- | --- |
| raw `fetch(` | 190 |
| `useTenantSWR` | 117 |
| `useTenantMutation` | 8 |
| `@/lib/api-client` | 14 |

`useTenantSWR` genuinely won for reads, and its docblock's "canonical" claim
is accurate — left alone.

`useTenantMutation` opened with "Epic 69 — canonical tenant-aware mutation
helper" and had 8 consumers against 190 raw-`fetch` files. That is not
canonical, and claiming it made the codebase *look* inconsistent when it was
in fact consistent about something else. Worse, it sent every new
contributor to reconcile a 190-vs-8 contradiction that has no answer.

## The decision: keep it, demote the claim

`useTenantMutation` is **not** deleted, because it does something raw
`fetch` cannot: apply the predicted state to the SWR cache synchronously and
roll it back if the request fails. `fetch` + `router.refresh()` produces a
visible full-page refetch instead.

It is simply not the default. The docblock now says so, with the measured
counts and a rule of thumb — reach for it when the interaction is
latency-sensitive (inline status changes, drag reordering, row toggles);
use `fetch` + `router.refresh()` for the rest.

**Mass-migrating the 190 raw-`fetch` sites is explicitly NOT implied.** Most
of them submit a modal and navigate; optimistic cache updates would add
rollback semantics they do not need, across a very large behavioural
surface, for no user-visible gain.

## Deleted: the tier with no consumers

Six per-domain hook modules — `use-assets`, `use-controls`, `use-risks`,
`use-evidence`, `use-tasks`, `use-policies` — measured at **zero importers**,
by import path and by exported name.

`use-api.ts` is **kept**: the roadmap item lists it among the zero-consumer
files, but it has 6 real importers.

Two things went with them:

- `tests/guards/no-unsafe-any.test.ts` required all six to **exist**. A
  guard asserting the presence of code nothing calls is how dead code
  survives; the list now names the tiers that are actually live.
- `tests/unit/use-domain-hooks.test.ts`, whose own docblock explains it was
  written because those modules were "genuinely 0% (not loaded by any
  test)" — a coverage test for code with no production consumers.

## The `primary` slot: nearly a regression

The roadmap item says `FilterToolbar`'s `primary` slot "has zero consumers,
while all six surfaces use the undocumented `leading`". The first half is
wrong in a way that matters: `processes/RulesTab.tsx` reaches it through
`EntityListPage`'s `toolbarPrimary` pass-through. A grep for `primary=` on
`FilterToolbar` call sites misses it, because the page never mentions
`FilterToolbar`.

The slot was removed and then **restored** once that consumer surfaced.
Only the docblock changed: it used to say header "Create" buttons "should
migrate here over time", which never happened — all six list surfaces use
`leading`. It now describes the layout the product has, and names the one
right-edge consumer.

## Decisions

- **Docblocks describe, not aspire.** Every claim in this change is a
  measured count, so the next reader can check it rather than trust it.
- **Keep capability, drop the false claim.** The alternative reading of
  "pick one write path" — adopt `useTenantMutation` everywhere — was
  rejected on cost/benefit, not difficulty, and the reasoning is recorded
  so it can be revisited.
- **`use-api.ts` survives its listing.** Consumer counts were re-measured
  rather than taken from the brief.
