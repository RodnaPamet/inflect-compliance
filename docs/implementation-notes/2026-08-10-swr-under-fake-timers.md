# 2026-08-10 — Auditors page on the data-access conventions, and the SWR/fake-timer recipe

**Commit:** `<pending>` refactor(audits): auditors page onto useTenantSWR + useTenantMutation

Continues the P3.1 migration from `2026-08-10-audits-data-access.md`. Four
writes and two reads on `audits/auditors/page.tsx`. The interesting part is not
the migration — it is the test failure that blocked it for a day.

## The blocker, and the recipe

Migrating the page's reads to `useTenantSWR` turned
`tests/rendered/auditor-revoke-safeguards` from 8/8 to 5/8. Three failures, two
distinct causes, and the second one will hit every remaining file in this
migration that has an undo flow.

**Cause 1 — SWR's cache is module-global.** Without a per-test cache the first
test's optimistic removal is still applied when the next test renders, so the
row it needs is absent. Fix: wrap each render in
`<SWRConfig value={{ provider: () => new Map(), … }}>`.

**Cause 2 — fake timers installed before the first read.** This is the one
worth writing down. The suite installed `jest.useFakeTimers()` in `beforeEach`,
i.e. before the page's initial SWR fetch. SWR schedules revalidation on timers,
so under a frozen clock that read never settles and the cache entry is never
populated. The first `mutate()` then indexes into an undefined internal state
and surfaces as:

```
TypeError: Cannot read properties of undefined (reading '6')
```

— thrown from inside SWR, naming nothing about timers, caches or the page. It
is a genuinely unhelpful error, which is why it cost a day.

The fix is ordering, not configuration:

```ts
// 1. let the data land on REAL timers
await waitFor(() => expect(document.getElementById('…')).not.toBeNull());

// 2. fake the clock for the 5-second window ONLY
await withUndoClock(async () => {
    fireEvent.click(revokeButton);
    await jest.advanceTimersByTimeAsync(6000);
    …
});
```

`withUndoClock` installs fake timers, runs the body, and restores real timers in
a `finally`. This is the shape `tests/rendered/traceability-panel-undo.test.tsx`
already used — it was the working precedent, and the new suite is now written
against it rather than rediscovering it.

**Apply this to every remaining undo-flow file in the migration.** The symptom
is not recognisable, so the cost of not knowing is a full debugging cycle each
time.

## Two defects the migration surfaced

- **`revokeAccount` had no `catch`.** A network throw escaped its `finally` as
  an unhandled rejection: the modal stayed open, the spinner stopped, and no
  message appeared. Now caught and surfaced.

- **The undo revoke must stay OUT of `useTenantMutation`.** A mutation hook
  sends its request immediately; the whole point of the Epic 67 undo toast is
  that the DELETE does not fire until the 5-second window closes. That site
  keeps the toast's lifecycle and takes only the shared request helper. Worth
  stating explicitly, because "migrate every write to `useTenantMutation`" reads
  like it includes this one.

## Files

| File | Role |
| --- | --- |
| `src/app/t/…/audits/auditors/page.tsx` | 2 reads → SWR, 3 writes → `useTenantMutation`, 1 undo write → shared `send` |
| `tests/rendered/auditor-revoke-safeguards.test.tsx` | per-test SWR cache + `withUndoClock` |

## Decisions

- **One `send` helper rather than four `fetch` blocks.** The four writes had
  drifted: three carried a try/catch and one did not. A single request shape is
  what stops that recurring, and it is what the undo site can share without
  taking the mutation lifecycle with it.

- **`setAuditors` resolves its updater before calling `mutate`.**
  `useTenantSWR` wraps SWR's `mutate` and does not accept the positional
  `(fn, shouldRevalidate)` form; the updater is applied against the current
  data and the result passed with `{ revalidate: false }` — a rollback means
  "put back what the user saw", not "ask the server".

- **The account revoke predicts optimistically; the grant does not.** The
  revoke's outcome is fully known (status → REVOKED, grants → empty) and the
  user has already typed a confirmation. A grant row carries a server-set
  `grantedAt`, so predicting it would make the badge shift on revalidation.
