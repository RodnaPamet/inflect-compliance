# 2026-10-09 — Review queue and alias revalidation (Step 4b)

**Commits:** seven, not one — #3344 ("part 1", revalidate confirmed aliases at
every run), #3349 (a reviewer's decision is not always an employee link), #3350
(the six reviewer actions and what the server re-checks), #3353 (a decided
account must leave the queue), #3354 (mount the actions behind
`requirePermission`), #3357 (the review queue page), and later #3512 (emit the
reviewer override rate, which the design calls this phase's outcome metric).

Counted from the commits whose subject names the step. The first draft of this
note said six — it had missed #3512, which carries the `feat(4b):` marker
rather than `(Step 4b)`.

> **Written after the fact.** Reconstructed on 2026-10-16 from the commit
> history and the phases document — not from doing the work. The step shipped
> without a note.

## It was delivered in parts, and the status table records only the first

The Definition of done asks for "one branch, one pull request, driven to green
and merged". This step took seven, and the status table's `#3344 (part 1)` is
the honest consequence — a single-PR column cannot hold a seven-PR step.

The first six are not arbitrary slices. Read in order they are a dependency chain:
revalidate aliases before anything resolves against them (#3344); recognise
that a reviewer's decision is not always an employee link (#3349); implement
the six reviewer actions and what the server re-checks (#3350); make a decided
account actually leave the queue (#3353); mount the actions behind
`requirePermission` (#3354); and only then build the page (#3357).

That ordering is the interesting part. The write path is authorised before the
surface exists, so there is never a window where the page is the only thing
standing between a reviewer and the database.

## What `revalidateAliases` decided, and what it deliberately did not

An alias is a human confirmation, and the pass asks whether it is still
trustworthy against four facts — `ACCOUNT_RECREATED`,
`ACCOUNT_POSTDATES_EMPLOYMENT_END`, `HR_RECORD_REKEYED`, `HR_RECORD_VANISHED` —
a closed set so that "how often does recreation happen" stays answerable.

Two decisions in that file are worth carrying:

- **Order: suspend first, then resolve against the survivors.** Resolving
  against everything read and suspending afterwards would record the account as
  `CONFIRMED_ALIAS` on the very run that decided the alias was no longer
  trustworthy.
- **A departure is NOT a trigger.** Suspending on departure would take a
  leaver's account out of the leaver population and leave it indistinguishable
  from an unclassified service account — the opposite of what a leaver process
  needs.

> **Later note (2026-10-16).** #3613 found the gap in that closed set: a veto
> contradicting an alias was not among the four, so a confirmed alias could be
> vetoed on every run and never retired, returning the account to the queue
> indefinitely. The fix added `CONTRADICTED_BY_VETO`, applied *after* resolving
> — because vetoes are the engine's and this pass runs before it, and
> re-deriving them here is exactly the duplication the `HR_RECORD_REKEYED` note
> in this file refuses.
