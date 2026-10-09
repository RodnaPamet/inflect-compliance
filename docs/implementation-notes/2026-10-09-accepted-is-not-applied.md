# 2026-10-09 — An accepted external write is not an applied one

**Commit:** see the PR for #3324 — `fix(external-write): an accepted write is not an applied one`

## The defect

`external-write-dispatch` settled `APPLIED` the moment `callTool` returned:

```ts
try {
    await callTool(transport, row.advertisedToolName, args);
} catch (err) {
    await settleWrite(ctx, row.id, 'INDETERMINATE', …);
    continue;
}
await settleWrite(ctx, row.id, 'APPLIED', null);
```

For a tool whose far end is asynchronous, `callTool` returns at **acceptance**.
Measured against a live licensed tenant:

```
07:07:11Z  POST …/entitlementManagement/assignmentRequests  -> 200
                                   state = submitted/Accepted
07:10:20Z  poll  state = delivered/Fulfilled     <- 3m09s after the POST
```

A request can also fail *after* acceptance — a policy violation, an ineligible
target, an unavailable resource. So a 200 is not evidence the subject has
access, and `APPLIED` is a positive claim that the far end changed.

**The asymmetry is the bug.** The catch arm already reasons carefully about what
is knowable:

> `INDETERMINATE`, not `FAILED`. The request may have arrived and been applied
> before the connection broke, and `FAILED` is a positive claim that the far end
> changed nothing — which nobody here can make.

Nobody at the POST site can make the inverse claim either. The failure path
thought about it; the success path assumed.

## Why not reuse `INDETERMINATE`

`INDETERMINATE` means *we do not know whether anything changed*. Here we know
exactly what happened: the request was taken and queued. Collapsing the two
makes a healthy asynchronous write indistinguishable from a lost response — and
the lost response is the one that needs an operator. So the owner's decision was
a new enum value, which is the accurate record rather than the cheap one.

## Files

| file | role |
| --- | --- |
| `prisma/migrations/20261009130000_…/migration.sql` | `ADD VALUE IF NOT EXISTS 'ACCEPTED'`, alone in its file |
| `prisma/schema/enums.prisma` | the member, declared **last** |
| `…/usecases/external-write-dispatch.ts` | `ASYNC_DELIVERY_TOOLS` and the `ACCEPTED` arm |
| `…/usecases/external-write-journal.ts` | `SettledOutcome` widened |
| `…/jobs/external-write-dispatch.ts` | the counter accumulated |

## Decisions

- **Declared LAST in `enums.prisma`, not beside `APPLIED`.** A bare `ADD VALUE`
  appends to the end of the physical type, and `prisma migrate diff` compares
  enum values as a **set** — it cannot see an order disagreement, so nothing
  would have caught the mismatch except
  `enum-member-order-matches-migrations`. Verified against the live type rather
  than reasoned about: `enumsortorder` on a freshly migrated database ends
  `[… INDETERMINATE, ACCEPTED]`. `ExternalWriteOutcome` is not in that guard's
  `ORDINAL_SENSITIVE` list and appending cannot renumber an existing member, so
  there is no ordering consequence — but the agreement still has to hold.

- **`IF NOT EXISTS`, and alone in the file.** Both are required by
  `migration-enum-isolation`, which exists because of outage #2745 (~25 hours
  down). Postgres commits an enum addition in a way that does not roll back
  with the surrounding transaction, so a later failing statement leaves the
  value permanent while the rest is not — and `migrate resolve --rolled-back`
  then re-runs the file, where a non-idempotent `ADD VALUE` fails against the
  enum that already contains it.

- **Which tools are asynchronous is declared in OUR source.** The obvious design
  is an `asyncDelivery` annotation the tool advertises, and it is wrong twice:
  the far end is the customer's server, so the hint is written by the party
  whose behaviour it describes; and `hashToolManifest` hashes `inputSchema`
  **only**, so an annotation is not covered by the pin a human accepted — a far
  end could add or remove it after acceptance with nothing going red.

- **Keying on the advertised name is safe in the direction that matters.** A
  customer's server could advertise a same-named tool and be read as
  asynchronous when it is not; `ACCEPTED` claims strictly *less* than `APPLIED`,
  so that false positive under-claims. The damaging direction is the false
  negative — an async tool absent from the set — which is the defect being
  fixed.

- **A cross-check test, because a rename is silent.** A literal string goes
  stale the moment the endpoint renames its tool, and the grant would settle
  `APPLIED` again with nothing reddening. The test finds the route by **glob**,
  not path, because the route has already moved once (#3323), and carries a
  positive control that the glob matched a file at all — a glob matching
  nothing makes every assertion over it pass by having no subject.

- **The counter is accumulated in the job too.** Without that an accepted write
  is counted nowhere, and a pass that accepted twelve requests reports zero
  applied, zero refused and zero indeterminate — reading as a pass that did
  nothing.

- **The state is terminal, and that is filed rather than hidden** (#3334).
  Nothing promotes `ACCEPTED` to `APPLIED` or `FAILED` on evidence. An honest
  terminal state beats a false one, but it has a shelf life: after long enough
  it says "not yet known" when the truth is "never happened and nobody
  noticed".
