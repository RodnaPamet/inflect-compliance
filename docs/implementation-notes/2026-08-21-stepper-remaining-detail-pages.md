# 2026-08-21 — prev/next stepper: triage of the remaining detail pages (#99)

**Commit:** `(this branch) feat(stepper): step test runs, BIAs and access-review campaigns`

## Design

#2057 inverted the stepper's id source: the LIST page publishes the order it
actually rendered, the DETAIL page reads it (`usePublishDisplayedOrder` /
`useEntityListIds`). Seven pages were wired there. This change works through
the detail routes that were left, and the deliverable is as much the
**declines** as the wiring — arrows that walk a list the user never saw are
worse than no arrows.

The question asked of each page was one thing: *does a user ever move between
siblings in a remembered order?*

### Wired

| Page | Publisher | Shape |
| --- | --- | --- |
| `tests/runs/[runId]` | `components/test-plans/TestPlanDetailView` — the "Run history" block | `orderKey` + null `listKey`, keyed per plan |
| `audits/business-continuity/[id]` | `BusinessContinuityClient` — the BCM register | `orderKey` + null `listKey` |
| `access-reviews/[reviewId]` | `AccessReviewsClient` — the campaign register | plain `listKey` (fallback left ON) |

Two of the three use the `orderKey` + null-`listKey` axis the #107 hook left
open, for two different reasons:

- **Test runs have no list route at all.** The only surface that renders a
  plan's runs as a peer list is the run-history block on the plan detail, so
  that view publishes under `CACHE_KEYS.tests.runs(planId)` — a key that is
  never fetched, only used as a namespace. Keying it per PLAN is what makes
  the stepper walk *this* plan's runs instead of every run in the tenant.
- **The BCM register is server-rendered** (`initialRows` prop) and filtered
  entirely in the browser. There is no client list-cache entry a fallback
  could read, so "published order or nothing" is the only honest answer.

The access-review register is the opposite case and keeps its fallback: it is
a genuine SWR resource in the `CappedList` shape the hook already unwraps, so
a campaign opened from a notification still steps in server order.

### Declined

- **`audits/nis2-gap/respond/[assignmentId]`** — a respondent's questionnaire,
  reached from a notification or the owner's per-role assignment table, never
  from a list of peers the respondent browsed. Its siblings belong to *other
  people*. It also holds unsaved radio-group answers, so a lateral
  `router.replace` would silently discard work in progress.
- **`admin/vendor-assessment-reviews/[assessmentId]`** — the closest call.
  The queue behind it genuinely is worked in order, which argues *for* arrows.
  Against: the page accumulates `overrides` / `finalRating` / `reviewerNotes`
  as local state, and a half-entered review is exactly what a lateral step
  destroys. Reviewing also moves the row out of the SUBMITTED bucket, so the
  order the arrows walk decays as the user works it. Worth revisiting behind
  a dirty-state guard; not worth shipping without one.
- **`admin/vendor-templates/[templateId]`** — a questionnaire *builder*
  (sections, questions, reordering) with substantial unsaved draft state.
  Templates are edited one at a time, not browsed.
- **`admin/integrations/[connectionId]`** — reached from
  `/admin/integrations`, which is a multi-section dashboard (already an Epic
  52 `ListPageShell` exemption), not a list of peers. Connections are
  heterogeneous card groups; "next connection" jumping from a SharePoint site
  to an Okta directory is not a sequence anyone holds in their head.

The three declines with unsaved page-level state share one root cause, which
is worth naming: `EntityPrevNextNav`'s keyboard binding already refuses to
fire from an editable target, but a *click* on the chevron does not, and
`router.replace` gives no confirm. Until the stepper grows a "block if dirty"
hook, edit-heavy surfaces stay out.

## Files

| File | Role |
| --- | --- |
| `src/lib/swr-keys.ts` | `tests.runs(planId)` — the namespace the run order is published under |
| `src/components/test-plans/TestPlanDetailView.tsx` | publishes the run-history order |
| `src/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page.tsx` | reads it; `prevNext` on `EntityDetailLayout` |
| `src/app/t/[tenantSlug]/(app)/audits/business-continuity/BusinessContinuityClient.tsx` | publishes the filtered register order |
| `src/app/t/[tenantSlug]/(app)/audits/business-continuity/[id]/BiaDetailClient.tsx` | reads it |
| `src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx` | publishes the campaign order |
| `src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx` | reads it |
| `tests/rendered/access-review-detail.test.tsx`, `tests/rendered/access-reviews-list.test.tsx` | `useParams` added to their local `next/navigation` mocks |

## Decisions

- **`labelSingular` names a slug the catalog does not carry yet** for two of
  the three (`bia`, `accessReview`). Both render the generic
  "Previous / Next item" today. Naming the slug anyway makes landing the
  phrase pairs in `messages/en.json` + `messages/bg.json` a messages-only
  change with no follow-up in this code. `testRun` is already in the catalog
  and renders properly. The catalog is deliberately a whole phrase per entity
  per direction, not an adjective interpolated into a noun, because Bulgarian
  adjectives agree in gender.
- **The run order is published from a shared component, not a page.**
  `TestPlanDetailView` backs two routes (`/tests/plans/{id}` and
  `/controls/{cid}/tests/{pid}`). Publishing from the component rather than
  either page means both entry paths produce a working stepper, which is the
  behaviour a user expects — the run they open does not know which door they
  came through.
- **`plan.runs` is published verbatim, cap included.** The API caps the
  embedded run array (`_count.runs` can exceed `runs.length`) and the history
  block says so in its header. Publishing the capped set means the stepper
  cannot offer a run the history never listed, which is the same invariant the
  access-review test pins against `truncated`.
- **A rendered suite's `usePathname` has to be the real path.**
  `PageHeader` classifies the route through `page-segregation` and renders
  the stepper via `titleAdornment`, which it drops on a MAIN page (whose H1
  is `sr-only`). A mock that hard-coded the LIST pathname for both mounts
  made the detail page classify as MAIN and hide the arrows while the hook
  returned the right ids — a failure that looks exactly like broken wiring.
  The suites carry a `currentPath` the tests move, and an assertion on the
  hook's output sits beside the DOM assertion so the two failure modes are
  distinguishable.
- **The two existing access-review rendered suites needed `useParams` in
  their local `next/navigation` mocks.** `useDisplayedOrderKey` scopes the
  published order by route slug, so any component newly carrying the stepper
  throws in a suite whose mock omits it. Thirteen tests across those two files
  went red on the first run and green after — that pairing is the evidence
  this wiring actually mounts, and it is the same failure mode that bit the
  previous wave.
