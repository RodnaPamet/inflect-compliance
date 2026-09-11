# 2026-09-11 — Server-side search on the identity roster, and the exemption that said it was bounded

**Commit:** `<pending>` feat(identity): search the synced-identity roster on the server

`tests/guards/filter-toolbar-coverage.test.ts` excused the identity-accounts
page from the filter-toolbar requirement because the roster is "bounded
per-tenant". The 500-row cap in `src/lib/identity-roster.ts` is the evidence it
is not, and the two could not both be true.

## The premise, checked before anything was built

Both halves are in the source, not inferred:

- The route caps at `IDENTITY_ROSTER_PAGE_SIZE = 500`, a hard cap with no
  cursor and no `truncated` flag (`src/lib/identity-roster.ts`, passed as the
  `take` in `listConnectedAccounts`).
- A directory sync stores up to `MAX_USERS = 5000` accounts **per connection**
  — the same constant in all four provider clients (`okta`, `google-workspace`,
  `entra-id`, `active-directory`) — a tenant may hold several connections, and
  a directory larger than that is synced across several runs
  (`usecases/identity-sync.ts`).

So ten times the cap is an ordinary size, and the page has rendered a
truncation warning since #2412 precisely because the cap fires. The exemption
was the wrong half.

The consequence is not cosmetic on this page specifically: it is where an
operator sets the never-offboard flag, so an account past row 500 was
unreachable *and* unprotectable, and indistinguishable from one that does not
exist.

## Design

**Search in SQL, not over the delivered page.** `listConnectedAccounts` gained
`q`, applied as a `contains`/`insensitive` `OR` over `email`, `displayName` and
`externalUserId`, nested inside the same `where` object as `tenantId` so the
disjunction is ANDed with the tenant scope. A client-side filter would have
looked identical and fixed nothing — it can only hide rows already delivered,
never reveal the ones the cap cut.

`externalUserId` is searched but never rendered. It is the id an operator
copies out of the provider's own console, and the only precise handle when two
connections carry one human under one email.

**The cap stays at 500.** Raising it was rejected: the access-reviews directory
gate compares `accounts.length < IDENTITY_ROSTER_PAGE_SIZE` and stands down
when the roster might be short, so a larger number flips it from failing open
to *disabling* directory options for every tenant sitting between 500 and the
new number — a visible truncation traded for a silent behaviour change in a
different feature. With search, the cap is a page size rather than a
reachability limit.

**Both parameters are opt-in, and that is the load-bearing part.** Called with
no options the usecase produces exactly the `where` it always produced, because
that gate reads this route unfiltered and infers "nothing synced" from a short
page. Under `?q=` or `?provider=` a short page means only "the matches fit" —
a filtered page of three would tell the gate every other provider is unsynced
and disable it. Nothing in the type system relates a query string in one file
to a length comparison in another, so `tests/guards/identity-roster-reachability.test.ts`
asserts the gate's read carries no query string. It was mutation-proved:
appending `?provider=okta` to that read turns it red.

**One facet, and one deliberately absent.** `provider` is a fixed enum of the
four directory kinds, single-select because the route's parameter is one
provider. There is **no connection facet** even though rows now carry
`connectionId` + `connectionName` (#2412): its options could only be derived
from the loaded rows, and the loaded rows are the truncated page this change
exists to see past — so a second connection whose accounts all sort past the
cap would be missing from its own filter. Search reaches those rows; a facet
built from them cannot.

**Two empty states, because they mean different things.** A filtered read that
matches nothing renders "No accounts match this search", not "No synced
accounts yet. Connect and sync…". Telling an operator the directory is unsynced
when their search simply missed is the same false absence the cap used to
produce.

**A request sequence guard.** The toolbar commits a search on a 250ms debounce,
so two roster fetches can be in flight and may answer out of order. A stale
answer rendered under the current search box would be the page asserting that
*these* are the accounts matching what was typed — on a page whose job is
"this account exists / does not", that is the one lie worth code.

## Files

| File | Role |
| --- | --- |
| `src/lib/identity-roster.ts` | The cap's docblock now states what the cap is and is not, and the rule the gate's comparison depends on; adds `IDENTITY_ROSTER_SEARCH_MAX_LENGTH`. |
| `src/app-layer/usecases/integrations.ts` | `listConnectedAccounts` gains `q`, applied in the `where`. |
| `src/app/api/t/[tenantSlug]/admin/integrations/identity-accounts/route.ts` | Forwards `q`; response shape and no-params behaviour unchanged. |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/page.tsx` | `FilterProvider` + `FilterToolbar`; toolbar state drives the server query; two empty states; request-sequence guard. |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/identity-accounts/filter-defs.ts` | The provider facet, and the written reason there is no connection facet. |
| `tests/guards/filter-toolbar-coverage.test.ts` | The exemption is deleted, with the reason it was wrong left in its place. |
| `tests/guards/list-page-shell-coverage.test.ts` | Same "bounded per-tenant" claim corrected; that exemption stands on layout grounds, which are real. |
| `tests/guards/identity-roster-reachability.test.ts` | The cross-file invariant: reachable by name, and the gate reads unfiltered. |
| `messages/{en,bg}.json` | Search placeholder, provider labels, the two empty-state strings, and a truncation notice that no longer says "has no search". |

## Decisions

- **The response envelope is untouched.** It is still `{ accounts: [...] }`.
  The access-review page reads this body through a reader that fails open on an
  unrecognised shape, so adding fields is safe and changing the shape is not —
  and a `{ rows, truncated }` envelope here would re-inert that gate silently.
  The cap therefore still has no wire flag, and the page still infers
  truncation from `length >= cap`.
- **The old exemption was deleted, not reworded.** Rewording it would have kept
  a claim about volume in a place where the honest answer is "the volume is
  unbounded and the page now copes".
- **The sibling `list-page-shell` exemption was corrected, not removed.**
  Viewport clamping is a different question from faceting; that page has a
  standing truncation notice above its table and clamping would fight it. Only
  the false "bounded per-tenant" justification changed.
- **No pagination.** Search makes every account reachable, which is what the
  exemption turned on. A cursor would also mean a wire-shape change on the one
  route whose consumer fails open on unrecognised shapes — a larger and
  riskier change than the defect warrants.
- **Read surface only.** `listConnectedAccounts` has one caller, the GET route;
  the leaver pass's blast-radius denominator is a separate
  `connectedIdentityAccount.count()`. Nothing here can alter what a pass writes
  or when it refuses.
