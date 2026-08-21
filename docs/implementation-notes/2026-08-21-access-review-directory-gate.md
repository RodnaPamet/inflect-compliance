# 2026-08-21 — The access-review directory gate, which had never once fired

**Commit:** `<pending>` fix(access-reviews): read the directory roster off the shape the route actually sends

The "New campaign" modal on `/t/:slug/access-reviews` gates its Directory
picker on what has actually synced: a directory with no accounts is disabled
with a tooltip, and when nothing at all is synced the picker carries an inline
link to the integrations page. The gate had been inert since the day it
landed. Nothing under `tests/` touched it, so nothing said so.

## Design

### The predicate

```ts
const rows = Array.isArray(accountsQuery.data) ? accountsQuery.data : [];
const accountsKnown = Array.isArray(accountsQuery.data);
```

`GET /api/t/{slug}/admin/integrations/identity-accounts` returns
`jsonResponse({ accounts })` — an object. `Array.isArray` of an object is
`false`, always. So `accountsKnown` was permanently false, `syncedProviders`
permanently empty, no option was ever disabled, and the notice at the bottom of
the picker never rendered.

The generic on the fetch (`useTenantSWR<Array<{ provider; status }>>`) is an
unchecked assertion — `apiGet` casts, it does not validate — so the compiler
had nothing to object to. The other consumer of the same route, the identity
accounts admin page, reads `(await res.json()).accounts`, so the two halves of
the app disagreed about the response shape and only one of them was right.

### Why it survived

It failed OPEN. A gate that never fires and a gate with nothing to gate render
identically: every directory selectable, no notice. Picking an unsynced
directory then failed on submit with the server's (good) error message, which
is exactly the pre-gate behaviour the gate was written to improve on. There was
no symptom to report.

The code around it reads as considered, too. The comment above the fetch
documents a real guard against a *different* cause of the same symptom — an
absolute URL double-prefixing into `/api/t/{slug}/api/t/{slug}/...` and 404ing
silently — and the comment on the predicate explains why it is shape-guarded
rather than `data ?? []`. Both are correct. The wrong predicate sat between
them.

### The reader now has three states, not two

```ts
function readIdentityAccounts(data: unknown): IdentityAccount[] | null
```

`null` means "not known" — in flight, errored, or a body this reader does not
recognise. `[]` means "known, and nothing is synced". Those are different
answers and the gate acts on them differently, so folding them together is the
whole defect. That is also why this does not reuse `unwrapCappedList` from
`@/lib/list-backfill-cap`, which deliberately folds an unrecognised body into
`[]`: right for a picker that just needs options, wrong where `[]` disables
every option.

### The second cause, found only by running it

Fixing the reader made the notice appear and did not disable a single option.
There was a second, independent break downstream, in the shared `<Combobox>`.

It renders from `sortedOptions`, a state snapshot of the `options` prop,
re-synced by an effect keyed on

```ts
JSON.stringify(options?.map((o) => o.value))
```

That reads as "the option set changed" — but the snapshot holds the option
OBJECTS, not just their order. Marking an existing option unavailable is a
`disabledTooltip` appearing on an option whose value does not change, so the
key does not move, the snapshot is never refreshed, and the dropdown keeps
rendering the state it first captured. The caller cannot tell: the options it
passes are correct.

Because the picker mounts before the roster fetch resolves, this is the
*normal* path here, not an edge case. The gate had two independent reasons
never to fire and each one hid the other.

The key now carries `value` plus the flags that decide how an option renders
(`disabledTooltip` presence, `first`, `separatorAfter`). The whole option
cannot go in: `label`, `icon` and `disabledTooltip` are ReactNodes and a React
element holds a circular `_owner`, so `JSON.stringify` on one throws. Options
with none of those flags set contribute a constant, so every existing caller
keys exactly as before — access-reviews is the only site in the repo passing
`disabledTooltip` on an option today.

### Turning the gate on made its cap matter

The roster route takes 500 rows with no `truncated` flag on the response. A
capped list can answer "is this provider present?" but never "is it absent?" —
the rows that would have said otherwise may simply have been cut. Ordering is
`provider ASC`, so a tenant with 500+ `active-directory` accounts would have
had Okta disabled as unsynced, blocking a campaign the server would have
accepted. Dead code has no false positives; live code does.

So the flag is `directoryStatusKnown = accounts !== null && accounts.length <
IDENTITY_ROSTER_PAGE_SIZE`. At the cap the gate stands down and every option
stays selectable. The roster is also unfiltered by status, so a full page of
`DEPROVISIONED` rows tells us nothing about ACTIVE accounts beyond it — the
same comparison covers that.

The cap moved into `src/lib/identity-roster.ts` so the reader and the route
compare against one number rather than two that agree today.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx` | The reader, the three-state flag, the cap comparison. |
| `src/lib/identity-roster.ts` | `IDENTITY_ROSTER_PAGE_SIZE`, shared by the route's `take` and the gate's completeness check. |
| `src/app-layer/usecases/integrations.ts` | `listConnectedAccounts` takes the shared constant instead of a literal `500`. |
| `src/components/ui/combobox/index.tsx` | The option-snapshot re-sync key now notices availability, not just the value set. |
| `tests/rendered/access-reviews-directory-gate.test.tsx` | The gate's first coverage. |
| `tests/rendered/combobox.test.tsx` | The primitive-level invariant: availability changing under an open dropdown reaches the DOM. |

## Decisions

- **The bare-array arm stays in the reader.** The route sends `{ accounts }`
  today; the union keeps both arms visible rather than asserting one shape the
  type system cannot check anyway.
- **An unrecognised body fails open, and that is a trade.** It means a future
  envelope on the route re-inerts this gate silently, exactly as before. The
  alternative — disabling directories on a body we do not understand — blocks
  real work on a guess. The constraint is written at the reader instead: a cap
  or an envelope added to that route adds its arm here, in the same diff.
- **Every assertion in the test is paired.** The failure mode being fixed is an
  absence that looks like a success, so a test that only checked "the notice is
  not there" would have passed against the broken build. Each fail-open case
  mounts a body that *should* trip the gate first, in the same test, so the
  absence that follows is attributable to the body and not to a gate that never
  ran in the harness at all.
- **The `<Combobox>` fix is in the primitive, not worked around in the page.** A
  `key` on the picker that changed with the gate state would have remounted it
  and produced the same screen, in one file, while leaving the next caller who
  marks an option unavailable with the same silence. The prop is part of the
  primitive's contract; discarding a change to it is the primitive's bug.
- **The second cause was found by running the test, not by reading the code.**
  Both halves read correctly in isolation — the gate computes the right options,
  the Combobox renders the options it was given — and the seam between them is
  where the change was dropped. The rendered assertion is what closed it, which
  is the argument for the test being part of the fix rather than evidence of it.
