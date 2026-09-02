# 2026-09-02 — cloud-posture credential classification

**Commit:** `<pending> fix(posture): make a revoked posture credential reach the connection banner`

## The defect

`markAuthFailure` was unreachable from **both** cloud-posture collectors, so the
"credential revoked" banner could never be raised for an AWS, Azure or GCP
posture connection. Two independent gaps produced one silence, and either alone
was sufficient:

1. **The call site could not be entered.** `markAuthFailure(db, conn.id, e, …)`
   sits in the `catch` around `provider.runCheck` in
   `usecases/aws-posture.ts:105` and `usecases/cloud-posture.ts:94`. Neither
   provider throws: `AwsPostureProvider.runCheck` and `runPowerpipeBenchmark`
   both CATCH the non-zero CLI exit a revoked credential produces and RETURN
   `{ status: 'ERROR', errorMessage: 'collector error; stderr: …' }`.
2. **The writer would have refused anyway.** `markAuthFailure` no-ops on
   anything that is not an `IntegrationAuthError`. Even with the catch entered,
   a generic `Error` marks nothing.

The result was a connection that presented as healthy for as long as nobody
opened the execution ledger of a job that runs with nobody watching.

`powerpipe-core.ts`'s own H2 comment already named the case — "a revoked
credential (non-zero exit, empty stdout)" — so the mapping from that exit to a
credential problem was known. What was missing was the ability to tell it apart
from every other reason the CLI exits non-zero.

## Design

The fix is a **discriminator**, and its whole difficulty is that the two error
directions cost very different things:

- a MISSED auth failure is the old behaviour — a silently stale connection;
- a FALSE auth failure tells a customer their WORKING credential was revoked,
  on a network blip or a missing CLI. It is user-visible, it sends somebody to
  rotate a key that was fine, and it is the failure mode that teaches operators
  to ignore the one banner that means somebody must act.

So the classifier defaults to NOT flagging and recognises only an allowlist of
provider error codes that mean the request was never AUTHENTICATED. It is the
same shape as `oauth-token-fetch.ts` (which does this for RFC 6749 codes on a
400 body) and reuses that module's reasoning for the three OAuth2 codes.

```
 runCli / exec  ──►  res.missing ──────────────────────────► ERROR  (install the CLI)
                     │
                     └─ !res.ok ──► postureCredentialErrorCode(res.stderr)
                                      │                │
                                   code               null
                                      │                │
                       throw IntegrationAuthError    ERROR  (collector failure)
                                      │
                       collector catch ─► ERROR execution row
                                        ─► markAuthFailure  (banner raised)
                                        ─► noRetry = shouldBypassQueueRetry
```

Three deliberate placement decisions:

- **In the provider, not the usecase.** The usecase only ever sees
  `res.stderr.slice(0, 300)`. Classifying that copy would make detection depend
  on how chatty the CLI happened to be first.
- **Below the `res.ok` gate.** A benchmark that exited 0 has demonstrably used
  the credential; a marker in its warning noise is not a verdict.
- **Throwing rather than returning a richer result.** The collectors' existing
  `catch` already persists the ERROR row, calls `markAuthFailure`, and derives
  `noRetry` from `shouldBypassQueueRetry` — which is true for
  `IntegrationAuthError`, so a dead credential also stops being re-run three
  times inside 35 seconds. No new control flow in either usecase.

The allowlist is drawn from the providers' documented API error codes; there is
no captured-stderr fixture anywhere in the repo, and the module says so rather
than implying observation it does not have. AUTHORIZATION codes (`AccessDenied`,
`PERMISSION_DENIED`, `AuthorizationFailed`, …), clock codes (`RequestExpired`)
and throttles are excluded with the reason written down: a read-only posture
role missing one `Describe*` out of the hundreds a benchmark touches emits
`AccessDenied` while the credential is perfectly good.

Matching is case-SENSITIVE and word-bounded. Both do real work: Powerpipe
control ids are lowercase snake_case and several read like credential codes
(`compute_instance_unauthenticated_access`), and `ExpiredToken` is a prefix of
`ExpiredTokenException`.

## The second defect, found while fixing the first

`clearAuthFailure` ran on EVERY completion, `ERROR` included. Once marking
works, that retracts a revoked-credential banner on a run that never observed
the account — the credential is still dead and now nothing says so. Exit code 0
with unusable output (zero controls parsed, unreadable JSON) reaches that line,
so the throw upstream does not cover it. Both collectors now gate the clear on
`status !== 'ERROR'`.

Deliberately NOT `status === 'PASSED'`: a FAILED verdict is a successful
collection reporting a real gap, so the credential demonstrably worked, and
clamping to PASSED would strand the banner on a healthy connection for as long
as its benchmark keeps reporting gaps — which is forever, for most tenants.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/posture-credential-classification.ts` | New. The allowlist, the matcher, and the `IntegrationAuthError` raiser. Carries the excluded set and the provenance of the list. |
| `src/app-layer/integrations/aws-posture-provider.ts` | Classifies the non-zero exit; gains the `exec` test seam its Azure/GCP siblings already had, so `runCheck` is testable at all. |
| `src/app-layer/integrations/cloud-posture/powerpipe-core.ts` | Same classification for Azure + GCP. |
| `src/app-layer/usecases/aws-posture.ts` | `clearAuthFailure` gated on a completed run. |
| `src/app-layer/usecases/cloud-posture.ts` | Same. |
| `docs/aws-posture-connector.md` | Operator-facing description of when the banner is raised and cleared. |

## Decisions

- **403 is synthesised, not observed.** There is no HTTP response behind a CLI
  exit. It is the status AWS answers these codes with, and `markAuthFailure`
  keys on the class rather than the number, so it carries no other weight.
- **Only the allowlisted CODE reaches the message.** `IntegrationAuthError`'s
  message is persisted verbatim into `IntegrationConnection.authFailureReason`,
  a column exempt from field encryption and rendered in the admin UI. A
  Powerpipe stderr can carry a role ARN, a service-account email or a
  subscription GUID, so nothing from it is interpolated — the same rule
  `oauth-token-fetch.ts` follows for `error_description`. The benchmark id is
  the only other fragment, and it is length-capped.
- **The AWS provider gained an `exec` seam.** Adding one is a larger diff than
  mocking `node:child_process`, but the sibling providers already carry it, and
  the branch being added raises a customer-visible banner — shipping it with no
  way to exercise `runCheck` was not acceptable. The mutation campaign then
  found that `AwsPostureProvider`'s alarm→FAILED verdict had never had a test.
- **Two existing fixtures had to move.** `tests/unit/integrations/aws-posture-cli.test.ts`
  and `powerpipe-core.test.ts` each used the literal `'ExpiredToken'` as an
  arbitrary stderr sample in a test whose actual claim is "a non-zero exit is an
  ordinary collector ERROR". That claim is now conditional, so the sample became
  a neutral one and each file gained a test that the REAL runner's scrub does
  not hide a credential verdict — the only path where the production scrub runs
  before the classifier.
