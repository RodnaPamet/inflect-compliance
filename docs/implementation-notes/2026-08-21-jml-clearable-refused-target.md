# 2026-08-21 — giving the REFUSED_TARGET mail a clearing condition

**Commit:** `(this PR)` fix(jml): let a resolved hybrid account stop being a leaver-mail candidate

## The defect

`decideAndDisable` called `resolveWriteTarget` **before** `writer.readState`, so
the refusal was decided without ever asking the directory. That is fine for the
decision and fatal for the alert built on it.

`resolveWriteTarget` answers from the stored account row alone, and for the
hybrid case its answer never changes: `onPremisesSyncEnabled` is true because
the object is mastered on-premises, and it is *still* true after an
administrator does exactly what the mail asks and disables the account in Active
Directory. Nothing in the pass could observe that the work had been done.

So the NEEDS_ACTION mail could not be **satisfied**. The outbox dedupes
pre-journal refusals per day by link id, which bounded it at one mail per leaver
per day — forever, in the inbox it shares with INDETERMINATE, the one message a
human genuinely must act on.

The earlier framing of this item was that hybrid candidates are a *volume*
problem, to be partitioned out of the pass report. That framing is what hid the
defect: the report half already shipped in #2066, and partitioning a permanent
alert only moves it. The problem was never how many; it was that nobody could
make it stop.

## Design

The verdict is computed in its old position and **returned in a new one** —
after the read, and after the already-disabled branch:

```
  self-lockout → protected → ladder → [decide target] → readState
      → already-disabled?  → ALREADY_DISABLED   (silent; the mail clears)
      → target refused?    → REFUSED_TARGET     (still live; the mail stands)
      → DRY_RUN / write
```

The clearing condition is the account itself. Once it reads disabled there is
nothing left to ask anybody for — whoever disabled it, and wherever they did it.
A refused candidate therefore leaves by the `ALREADY_DISABLED` branch, which is
already contracted silent, and the daily mail stops without a new outcome, a new
email type, or a schema change.

Cost is one extra read per refused candidate. In `DRY_RUN` — the rung every
tenant is clamped at, and where this was generating mail — that is not a socket:
`resolveDirectoryWriter` hands the pass the snapshot reader, so it is one indexed
row from the last confirmed-complete enumeration. Above `DRY_RUN` it is a real
directory read against an account we are about to decline to write to, which is
worth it to buy the refusal a way to end.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-disable-account.ts` | Holds the target verdict across the read; returns it at 3b, or keeps it over a read failure |
| `src/app-layer/notifications/leaver.ts` | Module header: "the account is still live" is now a checked fact rather than an inference from the refusal |
| `tests/unit/identity-disable-account.test.ts` | Replaces the "refuses BEFORE reading state" assertion; adds the clearing behaviour, the counter, and the batch-level silence |

## Decisions

- **Held, not moved.** `resolveWriteTarget` still runs in its cheapest-first
  position and still costs nothing. Only the *return* waits. Moving the whole
  check below the read would have made an unsupported-provider refusal spend a
  network call, and would have reported `FAILED` for it when that call failed.

- **`ALREADY_DISABLED`, not a new outcome.** It already means "nothing to do",
  it is already silent, and it already carries the reconcile path for an
  unconfirmed earlier write. A ninth outcome would need a notification arm, a
  metric label and a template, all to say something the eighth already says.

- **A read failure keeps the refusal.** `FAILED` is a statement about a write,
  and no write was ever going to be attempted for a refused account. Reporting
  it would swap "disable this where it is mastered" for "the provider rejected
  the write" — a different instruction naming a different cause for the same
  live account.

- **Ahead of the `DRY_RUN` branch, unchanged.** A dry run exists to show what
  the pass *would* do, so it must still show this decision.

- **A cloud-side disable that Azure AD Connect will revert reads disabled only
  until the next cycle**, after which the refusal returns. The alert is quieted
  by a fact and resumes if the fact does, which is the behaviour to want.

- **Not the digest.** Turning N × R mails into R is worth doing and costs a
  Prisma enum migration (SIGNIFICANT class). It is also a different problem:
  once this nag is bounded, the N in that product is only the accounts that
  still legitimately need a human. Do it when a real tenant is on the ladder and
  the volume is observable, not on a speculative estimate.

## Field impact

None today. Every tenant is clamped at `DRY_RUN` with zero directory
connections in production, which is exactly why this was cheap to get right now.
