# 2026-08-10 — B3-5 tranche: splitting the first-run guard

**Commit:** `<pending>` test(risks): split rq3-ob-f into a mount guard + the rendered test

## What changed

`tests/guards/rq3-ob-f-first-run.test.ts` (7 cases) became
`tests/guards/risk-first-run-mount-coverage.test.ts` (3 cases).

The four deleted cases source-scanned `RiskFirstRunEmpty` itself for
`<EmptyState`, `variant="no-records"`, `tenantHref('/risks?create=1')`,
`title={t('title')}`, and an `onCreateClick … onClick: onCreateClick`
proximity match. Every one was **already covered behaviourally** by
`tests/rendered/risk-first-run-empty.test.tsx`, which renders the component
and asserts the CTA is a tenant-scoped link, that `onCreateClick` swaps it to
a button, and that the testid holds in the compact form.

They were strictly weaker duplicates — they proved characters were present in
a file, not that the CTA navigates anywhere. Deleted, not relocated.

A fifth pinned the English `description` prose. The ratchet-lifecycle policy
bans that outright: a copy edit should not turn CI red.

The three that survive are the one claim only a whole-file scan can make —
that `RisksClient`, the dashboard and the board each mount the primitive and
no longer carry the legacy plain-`<p>` shapes. Rendering three full page
components to assert an import would cost far more than it proves.

`RQ_CEILING` drops 36 → 35.

## What this did NOT achieve, stated plainly

The number of guard files referencing `RisksClient.tsx` is **unchanged (31)**.
A mount assertion is legitimate, so the file still appears.

B3-5's framing — "unfreeze RisksClient in one sweep" — measures the wrong
thing. The cost of a frozen file is not how many guards *mention* it; it is
how many **assert things about its internals that a refactor would move**.
This tranche removed four such assertions and left three that only care
whether an import exists.

## The remaining tax, measured

Of the guards touching `RisksClient`, classified by how many distinct app
entities each scans:

| Class | Count | Disposition |
|---|---|---|
| Cross-entity platform guards (2–15 entities) | 15 | **Leave alone.** RisksClient is one row in a set-completeness rule. Stripping it punches a hole in the rule, exactly as it would have for `bulk-delete-coverage`. |
| Risk-only (1 entity) | 9 → 8 | The real tax. One converted here. |
| Referenced by another path form | 5 | Need individual inspection. |

The eight remaining risk-only guards are `risk-score-explainer`,
`p3-risk-analytics-honest`, `polish-01-score-chip-a11y`,
`rq2-10-band-unification`, `rq2-5-coherence`, `rq3-4-tail-language`,
`rq3-5-histograms`, `rq3-6-loss-event-register`. Each needs the same
per-guard judgement applied here — is this claim already covered
behaviourally, is it prose, or is it something only a file scan can see? That
is deliberately not a sweep, which is why the original "one sweep" instruction
was the wrong shape for the work.
