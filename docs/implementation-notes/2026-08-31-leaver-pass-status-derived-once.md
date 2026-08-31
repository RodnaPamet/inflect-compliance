# 2026-08-31 — the leaver pass reports the status it recorded

**Commit:** `(this PR)` fix(jml): derive a leaver pass's status once, so the row and the return cannot disagree

Closes #2184.

## Design

`runIdentityLeaverPass` produces its status **twice**: once for the
`IntegrationExecution` row an operator reads at `/admin/identity-leaver-passes`,
and once for the value handed back to the job, which `executor-registry` copies
onto the job result. Both were hand-written ternaries, ~400 lines apart, and only
one of them had learned about truncation:

```
row     refused ? 'NOT_APPLICABLE' : truncated ? 'PARTIAL' : 'PASSED'
return  refused ? 'NOT_APPLICABLE' :                         'PASSED'
```

`LeaverPassStatus` did not contain `'PARTIAL'` at all, so the type agreed with
the wrong half. A truncated pass wrote `PARTIAL` to its own artefact and told
everything downstream of the queue it had passed.

The fix is one exported derivation, `leaverPassStatus(refused, resultCount)`,
called by both sites, plus `'PARTIAL'` in the union.

**A helper rather than a variable threaded between the two.** They cannot share
one: the record is written inside a `try/catch` whose entire purpose is that a
failed write must not fail the pass, so on the catch path there is no value to
thread. Deriving from the same inputs at both ends makes them equal by
construction rather than by discipline.

While moving the branch, `decisionsTruncated` was respelled from
`results.length > reported.length` to `results.length > MAX_REPORTED_DECISIONS`.
Those are provably equal — and "provably equal, expressed twice" is precisely
what let the status drift in the first place.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-leaver-pass.ts` | the derivation, the widened union, both call sites |
| `tests/unit/identity-leaver-pass.test.ts` | the agreement invariant + the missing half of the truncation test |

## Decisions

- **Reachability is nil today, and the fix still went in.** The blast-radius
  breaker refuses a batch above `MAX_DISABLES_PER_RUN` (50) rather than trimming
  it, and the report caps at `MAX_REPORTED_DECISIONS` (200), so no pass can
  produce a truncated list. The two ways that changes are both one-line edits
  (raise the breaker, lower the cap) that nobody would think to cross-check
  against a union in a different part of the file. A latent inconsistency held in
  place by two unrelated constants is not a safe one.

- **The union was NARROWER than the contract it feeds.**
  `JobOutcome.status` in `executor-registry.ts` already lists `'PARTIAL'`. So the
  type was not protecting an invariant, it was recording an assumption that had
  stopped being true — the downstream slot was waiting the whole time.

- **The test asserts the two outputs equal EACH OTHER, not that each equals a
  literal.** Three statuses pinned separately pass just as happily when both
  sides are wrong together, and say nothing about the property that broke.
  Equally, asserting both against `leaverPassStatus` would be true by
  construction the moment both call it, and would survive one of them being
  rewired back to a literal. Proved by mutation: restoring the old ternary on the
  return turns two tests red.

- **`NOT_APPLICABLE` still wins over `PARTIAL` when a batch is refused**, and the
  ordering is safe rather than lucky: `refused` is set at exactly one place, and
  that return carries `results: []`, so the two are mutually exclusive by
  construction. That reasoning moved into the helper's docblock with the branch
  it describes, rather than being left behind at one of the two callers.

- **Third instance of this shape in this subsystem** (#2170 was the mirror image:
  the sync *returned* `PARTIAL` while *persisting* `PASSED`). Fixing that one did
  not find this one, because a fix aimed at one direction of a two-site
  disagreement leaves the other direction untouched.
