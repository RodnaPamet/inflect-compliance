# 2026-10-26 — `POST /access-reviews/legacy`: an HTTP entrance for legacy recertification

## Design

`createLegacyAccessReview` (Step 5b) was complete, gated and tested, and nothing
over HTTP could call it: the proving-run script and the tests were its only
callers, while `POST /access-reviews` refused `LEGACY_APP` with a message that
pointed at no route. The other two scopes with flows of their own already had
leaves (`/agents`, `/connected`).

The new leaf mirrors `/connected`: `withApiErrorHandling(requirePermission(
'access_reviews.create', …))`, a rule in `route-permissions.ts` ordered before
the `[^/]+` detail pattern, a 201 carrying whatever the usecase returned. The
route parses, authorises and delegates. Every rule that makes the campaign a
true claim — the five named refusals, the subjects frozen at create, the
snapshot's population coverage frozen into provenance — stays in the usecase,
where the integration suite already proves it; the route's own integration test
proves those rules still hold when reached over HTTP.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/access-reviews/legacy/route.ts` | The route. |
| `src/app-layer/schemas/access-review.schemas.ts` | `CreateLegacyAccessReviewSchema` (moved here) and the strict body derived from it; the member route's refusal now names the new leaf. |
| `src/app-layer/usecases/access-review-legacy.ts` | Imports the schema instead of defining it. No behaviour change. |
| `src/lib/security/route-permissions.ts` | The rule, before the detail pattern. |
| `tests/guardrails/api-permission-coverage.test.ts` | Layer 1 reads code, not comments. |
| `public/openapi.json` | The generated stub entry, as the siblings have. |

## Decisions

- **Strict at the HTTP boundary, tolerant in the usecase.** The body is
  `CreateLegacyAccessReviewSchema.strict()`, so a body naming `scope`, a subject
  list or a coverage claim is a 400 rather than a key dropped in silence. The
  usecase keeps its tolerant parse, because a unit test pins that it IGNORES a
  smuggled `scope` and the proving-run script is a non-HTTP caller. The sibling
  create routes forward the raw body to their usecases' tolerant schemas; this
  one is stricter than they are, not equal.
- **The schema moved rather than being restated.** The strict body is derived
  from the usecase's schema with `.strict()`, so the two cannot disagree about a
  field. The schemas module cannot import a usecase, so the base schema moved
  there and the usecase imports it.
- **Layer 1 now reads code only.** Mutation-checking this route found that
  `api-permission-coverage.test.ts` read raw source, so a docblock spelling
  `requirePermission('…')` satisfied it with the real wrapper deleted — the first
  draft of this route's own docblock did exactly that. It now reads through
  `codeOf`. No route on main relied on a comment: all 478 cases passed
  unchanged.
- **`legacy`, not `legacy-app`.** It drops `_APP` as `/connected` does for
  `CONNECTED_APP`.
- **No UI.** The create modal (`AccessReviewsClient.tsx`) offers the other
  scopes, but a legacy campaign needs a legacy-connection picker the modal does
  not have, so adding it is more than adding a scope.
