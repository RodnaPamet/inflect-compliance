# 2026-09-04 — posture collectors: exit 1 is a result, not a failure

**Issue:** #2284. Sits on top of #2301 (the control-summary wire shape), which
had to land first — parsing a run correctly is a precondition for deciding to
parse it at all. Does not depend on #2252 (`markAuthFailure` reachability),
which stays open.

## What was wrong

Both posture collectors gated on `if (!res.ok)` and returned `ERROR` before
`JSON.parse`. `execFile` sets `err` for any non-zero exit, so `ok` was false
whenever powerpipe exited non-zero — and powerpipe's exit codes do not mean what
that gate assumed:

| code | `turbot/pipe-fittings` constant | powerpipe CLI reference |
| --- | --- | --- |
| 0 | `ExitCodeSuccessful` | no runtime errors, no control errors, no alarms |
| 1 | `ExitCodeControlsAlarm` | "completed with no runtime or control errors, but there were one or more alarms" |
| 2 | `ExitCodeControlsError` | "completed with no runtime errors, but one or more control errors occurred" |

Exit 1 is the routine outcome of every real compliance benchmark: one failing
control produces it. So the collectors discarded every benchmark that had
anything to report. Consequences, all of them silent:

- no posture `Evidence` was ever created for an account with a single alarm,
  which is essentially every account;
- the `FAILED` arm of the verdict ladder was unreachable in production;
- a tenant with a real compliance gap saw exactly what a dead collector host
  produces — `ERROR`, no counts, no controls.

The comment above the gate said it was failing *closed* "rather than parsing
empty stdout into a false PASS". That intent was right; it was written against
the wrong exit-code semantics.

## The exit code had to become available before it could be interpreted

Not the same defect in each file, and both had to be fixed first — otherwise the
restructure would rest on a value that lies.

- `aws-posture-provider.ts` derived `code: err ? (err.code ?? 1) : 0`. Measured
  Node shapes: exit 1 → `1`; exit 2 → `2`; a timeout's SIGTERM →
  `{code: null, signal: 'SIGTERM'}`; a `maxBuffer` overflow → `code` is the
  **string** `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`. So `?? 1` reported a signal
  death as "controls alarmed", and a field declared `number | null` could hold a
  string. The discriminator is `typeof code === 'number'`.
- `powerpipe-core.ts`'s runner returned no exit code at all — just
  `{ok, stdout, stderr, missing}`. A shared core cannot interpret what it never
  receives, so this needed a transport change. Azure and GCP inherit it.

## Design

One new module, `cloud-posture/powerpipe-exit.ts`, holds every part of this that
was going to be written twice otherwise: the codes, the truthful derivation
(`describeChildExit`), the classification (`classifyPowerpipeExit`), the
diagnostics that ride into `resultJson` (`collectorDiagnostics`), and the
verdict ladder (`powerpipeVerdict`). It imports nothing from either collector,
so there is no cycle with `aws-posture-provider.ts` — which is where the parser
and summariser live and which `powerpipe-core.ts` already imports from.

The gate is now "did the run complete", not "was the exit zero":

```
0 / 1 / 2                          → parse and score
signal death                       → ERROR  (the 15-minute timeout is SIGTERM)
spawn or stream failure            → ERROR  (ENOENT, ERR_CHILD_PROCESS_STDIO_MAXBUFFER)
any other code, or none at all     → ERROR
```

Everything below the gate is unchanged and still fires: unparseable JSON is
`ERROR`, zero parsed controls is `ERROR`, and #2301's `unknown` arm still routes
an illegible control to `ERROR`.

## Decisions

- **Exit 2 is parsed, not refused.** The vendor's word is "completed", so the
  JSON is there and the errored controls are in it — `powerpipeErroredControl`'s
  shape, which `summariseBenchmark` already counts. Refusing the run would
  discard every alarm alongside them and reproduce this issue's defect one rung
  up. The existing ladder decides; `resultJson` records the code and a WARN
  names it so a 2 cannot vanish.

- **…but exit 2 is never `PASSED`.** One clamp beyond "let the ladder decide",
  and it is the narrow one: if the collector counted a control error and our
  parse found none, we disagree with the collector about what happened, and a
  compliance product does not certify an account over a disagreement. `FAILED`
  and `ERROR` are untouched — the clamp only refuses the pass, so no real
  finding is lost. It is also independent of *why* powerpipe chose to exit 2,
  which is the part that could not be verified from source here.

- **The refusal message changed.** `'Powerpipe collector exited non-zero.'`
  described the old criterion and would have been false for the common case
  (a signal death carries no exit status at all). It is now
  `'Powerpipe collector did not complete the run.'`, and changing it forced
  every pinning test to be re-read rather than silently kept.

- **`validateConnection` keeps `!res.ok`, and says so in a comment.** It shells
  the AWS CLI, whose exit codes carry ordinary POSIX semantics. Only powerpipe
  overloads non-zero.

- **`code`/`signal`/`failure` are OPTIONAL on the runner result.** The `exec`
  seam accepts test doubles that model only success-vs-failure, and an omitted
  triple resolves fail-closed: exit 0 when the double says the run succeeded,
  "no exit status" when it says it failed. Every pre-existing `{ok:false}`
  double therefore keeps refusing, unchanged.

- **The `#2251` comment blocks in both usecases were rewritten, not deleted.**
  `markAuthFailure` is still unreachable for these collectors — the providers
  return rather than throw — but the old text explained that in terms of "a
  non-zero exit", which is no longer what reaches `ERROR`. A false
  present-tense claim about a security seam is worse than no claim.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/cloud-posture/powerpipe-exit.ts` | new — codes, derivation, classification, diagnostics, verdict ladder |
| `src/app-layer/integrations/aws-posture-provider.ts` | truthful `runCli` exit triple; the completion gate; shared verdict |
| `src/app-layer/integrations/cloud-posture/powerpipe-core.ts` | same, for Azure + GCP through the shared core |
| `src/app-layer/usecases/aws-posture.ts` | rewrote the now-false `markAuthFailure`-reachability comment |
| `src/app-layer/usecases/cloud-posture.ts` | the same comment, second copy |
| `docs/aws-posture-connector.md` | new "Run outcomes and the collector's exit code" section |

## What a reader should check before touching this again

The two collectors are near-duplicates of each other by history, and the shared
module is the only thing keeping the interpretation single-sourced. A fix
applied to one file and not the other is how they drifted in the first place —
`powerpipe-core.ts` is what Azure and GCP use, `aws-posture-provider.ts` is what
AWS uses, and the issue's own line numbers pointed at only one of them.
