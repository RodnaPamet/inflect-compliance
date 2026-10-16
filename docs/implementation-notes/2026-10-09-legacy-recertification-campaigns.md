# 2026-10-09 — Legacy recertification campaigns (Step 5b)

**Commits:** four — `65fbc5e1e` (#3361, creation, freezing and findings),
`e16adca58` (#3365, closing with provenance in the evidence), `a91730d83`
(#3368, filing evidence against the controls it evidences), `02762b5f5` (#3371,
the subsystem description).

> **Written after the fact.** Reconstructed on 2026-10-16 from the commit
> history and the phases document — not from doing the work. The step shipped
> without a note, and its status row carries an em dash because no single pull
> request delivered it.

## Why the status row is blank

Four pull requests, so the single-PR column has nothing true to hold. The
Definition of done's "one branch, one pull request" is not met for this step,
and the em dash is the honest rendering of that rather than an omission.

## What the four did, in order

1. **Creation, freezing and findings** — a campaign is built from a snapshot
   and the reconciliation run over it, and both are frozen into it. A campaign
   that re-read live data would attest a population that changed while it was
   being reviewed.
2. **Closing with provenance in the evidence** — the close writes what was
   reviewed and against which run, not merely that it closed.
3. **Filing against the controls it evidences** — a recertification is evidence
   for a control, and filing it where the control looks is what makes it
   findable at audit rather than merely stored.
4. **The subsystem description** — the recertification section of the design
   document extended into a full description.

## What the gates refuse

`createLegacyAccessReview` refuses on `NO_SNAPSHOT`, `SNAPSHOT_STALE`,
`SNAPSHOT_INCOMPLETE`, `NOT_RECONCILED` and `NO_SUBJECTS`. Every one is about
whether the population is something a person can vouch for: a campaign over a
partial snapshot, or over accounts nobody reconciled, is an attestation of
something the reviewer cannot see.

> **Later note (2026-10-16).** #3592's proving run reached this step for the
> first time in production: `AccessReview cmv9x9bdf00008bs3209exiqn`, 7
> subjects, `findingCounts {ORPHAN: 4}`. Two facts the run established that are
> not obvious from the code — the subjects are
> `AccessReviewConnectedDecision` rows keyed `<connectionId>:<accountKey>`,
> created undecided, so `AccessReviewDecision` stays 0 and "the campaign
> exists" is a different claim from "a recertification happened"; and
> `AccessReview.createdByUserId` has a foreign key to `User`, so a campaign
> cannot be created by `SYSTEM_PRINCIPAL` and needs `buildDelegatedJobContext`.
