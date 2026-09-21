# 2026-09-21 — A guard flag stops the run, and keeps it stopped

**Commit:** `<sha>` feat(agentic): a guard flag latches the run for human review

Phase 1, point 4: a `flag` verdict must force `AWAITING_APPROVAL` and the run
must never auto-continue past it.

## The default outcome did nothing

`GuardAction` has three values and the middle one is what a tenant gets without
configuring anything. Under `balanced`, a SUSPICIOUS finding in either
direction — and a MALICIOUS one on input — resolves to `flag`, whose contract
`policy.ts` states as *"allow, but force human review; NEVER auto-commit"*.

The adapter honoured only `assertGuardAllowed`, which fires on `blocked` alone.
So a flag changed nothing:

- flagged ARGUMENTS went on to the funnel;
- a flagged RESULT — tenant-authored text reading as an instruction — was
  returned into the model's context verbatim.

The guard ran, resolved a verdict, wrote it down, and let the call through.
That is the shape of a control that reports itself working.

## Throwing is necessary and is not sufficient

To a language model a tool that throws is a tool that did not work: it picks
another one and carries on. Refusing call three of seven while four through
seven proceed is auto-continuation with an extra error in the transcript — and
letting the agent route around the flag is the one thing a flag must not allow.

So `ReviewLatch` is one-way and invocation-wide. The first flag trips it; every
later call in the same invocation refuses BEFORE the funnel, before the guards,
before anything. There is no `clear()` and there must not be one: the run is
answered by a person, not by the next call going well.

`flueToolsFor` builds ONE latch and shares it across every tool's `run`
closure. Per-tool latches would let a flagged `list_risks` be followed by a
clean `list_controls`, which is exactly the routing-around being prevented.

## Decisions

### Both assertions, in that order

`assertNoReviewRequired` subsumes `assertGuardAllowed` — a block sets
`reviewRequired` too — but the narrower one runs first so a block keeps
reporting itself as `ai_guard_blocked` rather than being relabelled as
something milder.

### Record before throwing

Both assertions throw. A flag recorded after the throw is a flag nobody can
read: the latch would stay down while the call that should have tripped it
unwound. The test that pins this asserts `review.required` after a rejection.

### The result slice fires after the read, deliberately

The funnel has already run by then. That is fine — it is a READ, it is audited,
and nothing was committed. What must not happen is the text reaching the model,
so the flag is enforced between the funnel and the return.

### The latch carries rule ids, never content

An operator surface reading the latch must not become a second copy of the
injected text. The recorded shape is `tool`, `slice`, `direction`, `verdict`,
`ruleIds` — asserted as an exhaustive key list, so adding a `sample` field
fails a test rather than quietly leaking.

## What this does NOT do

It does not set `WorkflowRun.status = 'AWAITING_APPROVAL'`, because nothing
calls this adapter yet: `DRIVER_IMPLEMENTED.flue` is false and `DRIVERS` maps
only `static`. `review.required` is the question the driver will ask and
`review.flags` is what it will show the human; the status transition lands with
the driver that reads them.

The half delivered here is the half with teeth. Without it, the driver could
read a latch that never came up, because the guard that was supposed to raise
it allowed the call instead.

The STATIC driver needs none of this, and that was checked rather than assumed:
its SYNTHESIS step is a plain function over accumulated context, so it makes no
model call at all, and its only output path — a proposal — is already guarded
at the propose seam by `guardAgentProposal`.
