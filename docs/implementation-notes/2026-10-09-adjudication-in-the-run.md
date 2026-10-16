# 2026-10-09 — Adjudication in the run, and the review lanes (Step 6c)

**Commits:** seventeen pull requests, not one. The feature parts, in order:
`5a24fc3c0` (#3373, the mode gate), `b4b127624` (#3375, the verdict model),
`e7b879ab0` (#3378, the payload), `85faf39e7` (#3380, the adjudication pass),
`91c061964` (#3383, a production caller), `5747b4368` (#3386, adjudicate the
residue in the run), `36b1856c4` (#3387, the blind sample), `7db51a973`
(#3389, legacy-field injection vectors), `bd1d76a84` (#3390, the AGREES bulk
lane), `76dd7c661` (#3404, `AI_PROPOSED_CONFIRMED`), then fixes #3488, #3507,
#3510 and doc corrections #3508, #3515, #3538.

> **Written after the fact.** Reconstructed on 2026-10-16 from the commit
> history and the phases document — not from doing the work. The step shipped
> without a note.

## The em dash in the status table is correct

Step 6c's "Pull request" column is `—`, and that is not an omission. Its own
Definition of done asks for "one branch, one pull request, driven to green and
merged"; it took **thirteen feature and fix pull requests plus four
documentation ones**. There is no single number to put in the column.

**So criterion 7 is not met for this step, and should not be ticked.** It is
the one criterion here that is a genuine deviation rather than a formality: a
step delivered in thirteen parts is a different thing to review than a step
delivered in one, and the column quietly saying nothing is how that became
invisible.

## What it built

Model adjudication of the reconciliation *residue* — the accounts the
deterministic engine could not decide — behind a mode gate, with a verdict
model, a blind sample to measure agreement, and review lanes for the output.

Three decisions worth carrying:

- **Adjudication runs AFTER the resolutions are committed**, in
  `runLegacyReconcileJob` rather than inside `runLegacyReconcile`. That is what
  makes "never in an HTTP request" structural rather than a convention: a
  request can only reach the run, and the run cannot reach a model.
- **A refusal is not adjudicated.** The run wrote no resolutions, so there is
  nothing to annotate.
- **It is not allowed to fail the run.** The resolutions are on disk and
  adjudication only ever adds annotations, so the worst case is a queue that
  looks exactly as it would with the mode off — the designed fail-closed state.

## The unticked criterion

One of sixteen: *"With the kill switch engaged, no model call is made. An
unscored agent is denied."* Annotated **HALF met — #3508**. The kill-switch
half holds, proven by `KILL_SWITCH stops the batch with no model call`.

> **Later note (2026-10-16).** The "not allowed to fail the run" decision above
> is correct and it concealed a real defect for the life of the ESM bundle.
> #3611: the worker bundle used `__dirname` and never defined it, so importing
> `evaluation-record.ts` threw and the dynamic import of the adjudication
> module failed — every RESOLVED reconcile logging "adjudication failed, run
> stands" with `__dirname is not defined`. Found by the first production
> reconcile (#3592), not by a test: jest runs from source under CJS, where
> `__dirname` is always defined.
