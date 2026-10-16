# 2026-10-09 — Adjudication in the run, and the review lanes (Step 6c)

**Commits:** eleven, carrying twelve pull-request numbers — not one. Counted
from the commits whose SUBJECT names the step, which is the only count that
does not drift:

| | |
| --- | --- |
| #3373 | the adjudication mode gate (part 1) |
| #3375 | the verdict model and its derivation (part 2) |
| #3378 | build the adjudication payload (part 3) |
| #3380 | the adjudication pass (part 4) |
| #3386 | adjudicate the residue in the run (part 5) |
| #3387 | the blind sample, and a queue that honours it |
| #3389 | legacy-field injection vectors |
| #3390 | the AGREES bulk lane |
| #3404 | record `AI_PROPOSED_CONFIRMED`, keep a verdict reference (item 7) |
| #3488 / #3510 | read the vendor's truncation report, on the wire and unread |
| #3507 | discard a model answer naming an option the request never offered |

Twelve numbers, eleven commits: #3488's fix reached `main` as #3510. Later
documentation about the step (#3508, #3515, #3538) is not counted here — it
records why a criterion stays unticked rather than delivering the step.

> **Written after the fact.** Reconstructed on 2026-10-16 from the commit
> history and the phases document — not from doing the work. The step shipped
> without a note.

## The em dash in the status table is correct

Step 6c's "Pull request" column is `—`, and that is not an omission. Its own
Definition of done asks for "one branch, one pull request, driven to green and
merged"; it took **eleven commits across twelve pull-request numbers**. There
is no single number to put in the column.

**So criterion 7 is not met for this step, and should not be ticked.** It is
the one criterion here that is a genuine deviation rather than a formality: a
step delivered in eleven parts is a different thing to review than a step
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
