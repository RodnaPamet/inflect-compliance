# 2026-09-19 — cloud-posture credential trigger: the research, and why the code did not ship

**Issue:** #2413. **Supersedes as the home of the record:** `fix/posture-auth-failure-unreachable`
/ `fix/2252-posture-auth-trigger` — one commit, `4d891b6acaca70ac0d5826f9ec949e596a87cfd5`,
2026-09-02, **never opened as a PR and never merged**.

This note exists because two live comments in the test suite
(`tests/unit/integrations/aws-posture-cli.test.ts`,
`tests/unit/integrations/powerpipe-core.test.ts`) point a future author at "#2413, prior art
from the deleted `fix/posture-auth-failure-unreachable`" — and until now the repo held no
copy of that prior art. `git ls-remote origin` on 2026-09-19 shows the branch is **already
gone from the remote**; it survives only as a local ref on one machine. Everything a future
author needs is therefore reproduced here in full rather than cited to a commit that may not
be fetchable.

**The code should not ship. The research should not be lost.** #2252 is closed as completed
and its 2026-09-04 comment recommends against the trigger in terms this note preserves.

---

## 1. What the branch attempted

### 1.1 The defect it named

`markAuthFailure` was unreachable from **both** cloud-posture collectors, so a
"credential revoked" mark could never be written for an AWS, Azure or GCP posture
connection. Two independent gaps, either sufficient on its own:

1. **The call site could not be entered.** `markAuthFailure(db, conn.id, e, …)` sits in the
   `catch` around `provider.runCheck`. Neither provider threw — `AwsPostureProvider.runCheck`
   and `runPowerpipeBenchmark` both caught the non-zero Powerpipe exit and **returned**
   `{ status: 'ERROR', errorMessage: 'collector error; stderr: …' }`.
2. **The writer would have refused anyway.** `markAuthFailure` no-ops on anything that is not
   an `IntegrationAuthError`, so a generic `Error` marks nothing even with the catch entered.

That half of the diagnosis is **correct and still true today**. What the branch got wrong was
the discriminator it built on top of it.

### 1.2 The exact shape of the classifier

New module `src/app-layer/integrations/posture-credential-classification.ts` (169 lines),
modelled on `src/app-layer/integrations/oauth-token-fetch.ts` and citing it. Two exports:

```ts
export const POSTURE_CREDENTIAL_ERROR_CODES: readonly string[] = Object.freeze([
    // AWS
    'ExpiredToken', 'ExpiredTokenException', 'InvalidClientTokenId',
    'UnrecognizedClientException', 'InvalidAccessKeyId', 'SignatureDoesNotMatch',
    'AuthFailure',
    // Azure
    'AADSTS7000215', 'AADSTS7000222', 'InvalidAuthenticationToken',
    'ExpiredAuthenticationToken',
    // GCP
    'UNAUTHENTICATED',
    // RFC 6749 §5.2 — the three oauth-token-fetch.ts already treats this way
    'invalid_grant', 'invalid_client', 'unauthorized_client',
]);

export function postureCredentialErrorCode(stderr: string | null | undefined): string | null {
    if (!stderr) return null;
    for (const code of POSTURE_CREDENTIAL_ERROR_CODES) {
        if (new RegExp(`\\b${code}\\b`).test(stderr)) return code;   // case-SENSITIVE
    }
    return null;
}

export function throwIfPostureCredentialFailure(stderr: string | null | undefined, benchmarkId: string): void {
    const code = postureCredentialErrorCode(stderr);
    if (code === null) return;
    throw new IntegrationAuthError(403, `powerpipe benchmark run ${benchmarkId.slice(0, 120)}`, code);
}
```

Properties it argued for, each of which is independently defensible:

- **Allowlist, default-NOT-flagging.** `null` means "could not tell", never "the credential is
  fine".
- **Authentication vs authorization split.** Deliberately excluded as *authorization*:
  `AccessDenied`, `AccessDeniedException`, `UnauthorizedOperation`, `PERMISSION_DENIED`,
  `AuthorizationFailed` — a read-only posture role short one `Describe*` out of the hundreds a
  benchmark touches emits these while the credential is perfectly good. Also excluded: clock
  codes (`RequestExpired`, `RequestTimeTooSkewed`, which accuse *our* host) and throttles.
- **Case-sensitive and word-bounded.** Powerpipe control ids are lowercase snake_case and
  several read like codes (`compute_instance_unauthenticated_access`); `ExpiredToken` is a
  prefix of `ExpiredTokenException`.
- **Stated provenance.** These are the providers' *documented API error codes*, not strings
  observed in our logs. There was, and still is, **no captured-stderr fixture from a genuinely
  revoked posture credential anywhere in this repo.**
- **Credential hygiene.** Only the allowlisted *code* reaches the error message —
  `IntegrationAuthError`'s message is persisted verbatim into
  `IntegrationConnection.authFailureReason`, a column exempt from field encryption, and a
  Powerpipe stderr can carry a role ARN, a service-account email or a subscription GUID. The
  benchmark id is the only other fragment and is length-capped at 120. The `403` is
  *synthesised* — there is no HTTP response behind a CLI exit.

### 1.3 Where it hooked, and what else it changed

Two call sites, both immediately **below** the `if (!res.ok)` gate and **above** the
`return { status: 'ERROR', … }`, in the provider rather than the usecase (the usecase only
ever sees `res.stderr.slice(0, 300)`, so classifying there would make detection depend on how
chatty the CLI happened to be first):

- `src/app-layer/integrations/aws-posture-provider.ts` — `throwIfPostureCredentialFailure(res.stderr, benchmark)`
- `src/app-layer/integrations/cloud-posture/powerpipe-core.ts` — `throwIfPostureCredentialFailure(res.stderr, input.benchmarkId)`

It **threw** rather than returning a richer result, so the collectors' existing catch would
persist the ERROR row, call `markAuthFailure`, and derive `noRetry` from
`shouldBypassQueueRetry` — `true` for `IntegrationAuthError`. Three separable things rode
along in the same commit:

| Rider | Status today |
| --- | --- |
| `clearAuthFailure` gated on `status !== 'ERROR'` in both collectors | **Landed independently via #2251.** Present on main. |
| `exec` test seam on `AwsPostureProvider` (its Azure/GCP siblings already had one) | Useful infrastructure, independent of the trigger. |
| Neutralising the two `'ExpiredToken'` stderr samples | **Landed on main** (see §4.3). |

13 files, +1202/−9. The commit message claims 27 mutations all killed, with both controls.
**That campaign is the cautionary part of this record** — see §2.4.

---

## 2. The three refutations

All three concern design (a), the stderr classifier. Sources: the two 2026-09-04 comments on
#2252.

### 2.1 R1 — the opt-in-region false positive (the one #2252 was opened to avoid)

`buildCredentialEnv` sets exactly **one** `AWS_REGION` and there is no multi-region or
multi-account fan-out. A *healthy* credential aimed at a **disabled opt-in region** fails
every control (steampipe-plugin-aws#75) and is indistinguishable from a rejection by breadth
alone.

There is a second, **first-party** path to the same string: AWS STS **v1 global-endpoint
session tokens are not valid in opt-in regions**. An account using `roleArn` + `externalId`
(the shape `docs/aws-posture-connector.md` recommends), with one opt-in region enabled and the
account-default token version, produces `AuthFailure` on a perfectly healthy credential —
while `validateConnection`, which shells `aws sts get-caller-identity`, returns **green**. The
operator's "Test connection" button and the collector would disagree, and the collector would
win the banner.

### 2.2 R2 — the classifier is inert on the collection path: control errors never reach stderr

Checked against powerpipe v0.4.0, v1.0.0, v1.2.8, v1.3.0 and v1.5.3; routing stable across all
five:

- `ControlRun.setError` stores the text in `RunErrorString` (`internal/controlexecute/control_run.go:74,227-229`) and prints nothing.
- `internal/controldisplay/templates/json/output.tmpl:65` renders it as `"run_error"`.
- `check.go::displayControlResults` ends `io.Copy(os.Stdout, reader)` — every formatter drains to **stdout**.
- `ExecutionTree.Execute` returns `nil` unconditionally, so a control error can never reach the run loop's only stderr writer.
- There is **no child process to merge stderr from**: powerpipe reaches steampipe as a postgres client on `:9193`.

`throwIfPostureCredentialFailure(res.stderr, …)` therefore reads a stream that is **empty**
for an ordinary `powerpipe benchmark run`. Either reading kills the branch:

- control errors never reach stderr → the fix is a **no-op** that would have closed #2252 with
  a change that does nothing, while retiring the ticket recording the problem;
- some routing not enumerated there does put them on stderr → the fix is **exactly the harm**
  #2252 withheld it for.

Related and worth recording: **this repo pins no powerpipe version.** No Dockerfile stage, no
install script, no constant. `execFile('powerpipe', …)` resolves from `PATH`, and
`buildCredentialEnv` spreads `{ ...process.env }`, so `POWERPIPE_LOG_LEVEL` and
`STEAMPIPE_LOG_LEVEL` are inherited from the host. Any future design that depends on stream
routing depends on an unpinned binary.

### 2.3 R3 — region-independent: AWS's own definition of `AuthFailure` breaks the allowlist

This is the refutation that does **not** need the region argument, and the one that makes the
approach unrecoverable by narrowing the region configuration. AWS's EC2 error reference
defines `AuthFailure` as:

> The provided credentials could not be validated. You might not be authorized to carry out
> the request; for example, trying to associate an Elastic IP address that is not yours…
> Ensure that your account is authorized to use Amazon EC2, **that your credit card details
> are correct**, and that you are using the correct credentials.

Authentication, **authorization** and **billing**, under one code. The allowlist's whole
organising principle is the auth-vs-authz split of §1.2 — and AWS's most prominent entry on it
is not on one side of that split. No region argument required; no configuration removes it.

The same comment records a second internal contradiction: the allowlist carries GCP
`invalid_grant`, which Google returns for **collector-host clock skew** against a perfectly
valid service-account key. That is precisely the reason the module gives for *excluding*
`RequestExpired` / `RequestTimeTooSkewed` — that they "accuse the collector host's clock, not
the customer's credential". The module refutes its own entry.

### 2.4 The methodological finding, which is the most transferable thing here

The branch's `tests/unit/posture-credential-classification.test.ts` pinned this fixture as
meaning *credential revoked*:

```
Error: operation error EC2: DescribeInstances, https response error StatusCode: 401,
api error AuthFailure: AWS was not able to validate the provided access credentials
```

That is, character for character, the string a **healthy** account emits for a disabled opt-in
region. The suite did not merely fail to distinguish the two worlds — **it encoded the wrong
one as the specification.** Every fixture injected the marker through the `exec` seam as
`{ ok: false, stdout: '', stderr: … }`, a stream split that (R2) does not occur, so **no
mutation could have caught it.**

> A 27-mutation campaign with both controls, all killed, proves the tests are *consistent with
> the model the fixtures encode*. Mutation testing measures **consistency, not
> correspondence**. When the fixture is the hypothesis, a green campaign certifies nothing
> about the world.

---

## 3. Why the trigger stays withheld even for a *correct* discriminator

`src/app-layer/usecases/aws-posture.ts:196-211` (verified at this note's date; the equivalent
block is at `src/app-layer/usecases/cloud-posture.ts:175` ff.) records two reasons, and
neither is about the shape of the classifier:

1. **`authFailedAt` / `authFailureReason` have NO READER anywhere in the product.** They are
   selected into the `GET /admin/integrations` payload
   (`src/app-layer/usecases/integrations.ts:88-89` for the list, `:116-117` for the single
   connection) and rendered by nothing: the page's `ConnectionDTO`
   (`src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx:35-48`) does not declare either
   field, and `grep -rn 'authFailedAt|authFailureReason' src/app src/components` returns
   **zero** hits. **The "credential revoked banner" that the branch's commit message and its
   `docs/aws-posture-connector.md` addition both describe does not exist.**
2. Consequently a trigger would raise **nothing visible** — while `IntegrationAuthError`, the
   only class `markAuthFailure` acts on, is also one `shouldBypassQueueRetry` answers `true`
   for. So the single observable effect of shipping a correct trigger today is that the
   **nightly collection silently stops retrying**: strictly worse than the status quo, and
   invisible until someone opens the execution ledger of a job that runs with nobody watching.
3. **`buildCredentialEnv` sets exactly one `AWS_REGION`** with no fan-out — R1, stated as a
   prerequisite rather than an objection to the shape.

The asymmetry argument that justified the narrow allowlist is unchanged and still governs any
successor: a **missed** auth failure is today's behaviour, a stale connection; a **false** one
tells a customer to rotate a working key and teaches operators to ignore the one banner that
means somebody must act.

---

## 4. What main already has, that the branch did not

### 4.1 A discriminator that reads no provider text at all

`noControlObserved` in `src/app-layer/integrations/cloud-posture/powerpipe-exit.ts:211` is
true only when the run **completed**, parsed controls, and **not one** produced an
observation:

```ts
powerpipeRunCompleted(outcome)
  && counts.total > 0
  && counts.ok === 0 && counts.alarm === 0 && counts.skip === 0
  && counts.error === counts.total
```

Both collectors record it on the run as `noControlObserved: true` in `resultJson`, beside a
**counts-only** `errorMessage`. A single `ok` or `alarm` anywhere is proof the credential
authenticated at least once, which kills R1 without reading a byte of provider text. `unknown`
controls disqualify it on purpose: "we could not read this control object" is a fact about our
parse, not about the account.

It **records a fact; it does not accuse a credential.** Nothing there calls `markAuthFailure`,
and `tests/unit/usecases/posture-auth-failure-reachability.test.ts` pins that in both
directions.

### 4.2 The exit-code restructuring underneath all of it

`#2284` replaced the `if (!res.ok)` gate — the exact branch both of the parked classifier's
call sites hooked — with `if (!powerpipeRunCompleted(outcome))`. Exit 1 ("one or more alarms")
and exit 2 ("one or more control errors") are now **completed** runs that are parsed and
scored. The parked branch's own positive fixture uses exit code 1. A cherry-pick conflicts in
8 of its 13 files, and its `posture-auth-failure-reachability.test.ts` is the logical negation
of main's same-named file. **The commit does not apply, and re-deriving it would be cheaper
than resolving it.**

### 4.3 The latent trap named in #2413 is CLOSED

#2413 records, as a trap to fix later, that main still used the literal `'ExpiredToken'` as an
arbitrary stderr sample at `tests/unit/integrations/aws-posture-cli.test.ts:247,253` and
`tests/unit/integrations/powerpipe-core.test.ts:322,328`. **That is no longer the case.** As
of this note both samples are `'arbitrary-stderr-sample'`, each carrying a comment that bars
any string which could pass for a provider error code, precisely because those fixtures sit on
the did-not-complete gate a relocated classifier would hook. A repo-wide grep for
`ExpiredToken` returns only those two explanatory comments. Nothing remains to do there.

---

## 5. What would have to change for the idea to be viable again

Prerequisites, in the order they bind:

1. **A reader must exist first.** Ship `authFailedAt` / `authFailureReason` as a real UI
   surface — the banner the branch assumed. Until then the only effect of marking is silently
   stopping the nightly retry. *(This also weakens the payload argument that constrains what
   may be written to `authFailureReason`, so it must be re-argued, not inherited.)*
2. **The trigger must be structural, not textual.** Key on **breadth** — "the run completed,
   parsed controls, and every one errored" — which `noControlObserved` (§4.1) already computes
   and records. A substring match over provider text is refuted by R3 independently of
   everything else.
3. **If error *text* is ever needed, it must come from `run_error` on stdout, not stderr**
   (R2) — and `parsePowerpipeBenchmarkJson` currently discards it: `RawControl` declares only
   `control_id` / `name` / `title` / `results` / `summary`, and `summariseBenchmark` emits
   `{id, status}`, dropping the `reason` that carries it. Piping that text onward would route
   ARNs, subscription GUIDs and service-account emails toward `authFailureReason`, whose
   field-encryption exemption is justified by its **current narrow shape**. Reading it also
   re-opens R1 in its original form: in the default configuration the opt-in-region
   `AuthFailure` and the revoked-credential `AuthFailure` land in the *same field with the same
   text*.
4. **One captured stderr + exit code from a genuinely revoked posture credential.** Main
   models a revoked credential as exit 2 with a full JSON payload of errored controls
   (`tests/unit/usecases/posture-auth-failure-reachability.test.ts`); the branch modelled it as
   a non-zero exit with empty stdout and the code on stderr. **Both are inferences.** One real
   sample settles which signal a trigger should read and is worth more than either design.
   This deployment cannot produce one: production had 1 `IntegrationConnection` (`entra-id`)
   and 0 of 27 `IntegrationExecution` rows were posture.
5. **Account for the third configuration.** If an operator sets
   `ignore_error_codes = [..., "AuthFailure", ...]` — a widely-copied snippet for multi-account
   setups — the plugin swallows it at `logger.Debug`, it reaches neither stream, and the
   control reads as a clean `ok`/`skip`.

### 5.1 Every other candidate that was evaluated, and why each failed

| Design | Verdict |
| --- | --- |
| Breadth: all controls errored **with the same auth code** | The *code* half does not exist — `summariseBenchmark` drops the `reason`. The code-free half is `noControlObserved` and already shipped. |
| Require failure across all regions / accounts | **No breadth to require** — one `AWS_REGION`, no fan-out. |
| N consecutive failed runs | **Discriminates nothing.** Every surviving false positive (opt-in region, wrong Entra tenant, clock skew) is *persistent* and clears any N. Filters only transients, which an allowlist already excludes, and buys N days of latency. |
| Read the credential's expiry locally | **Not knowable.** AWS session tokens are opaque blobs, not JWTs; GCP SA keys do not expire; Azure secret expiry needs Graph `Application.Read.All`, which a read-only posture connector must not hold. |
| Azure/GCP-specific codes | `AADSTS7000215` is also returned by a **valid** secret against the wrong tenant authority — and `tenantId` is a config field here, so the remedy differs. GCP `UNAUTHENTICATED` is what the benchmark emits when `GOOGLE_APPLICATION_CREDENTIALS` was never written because `saJson` was empty — **our** failure, reported as the customer's. |
| Narrow to `ExpiredToken` alone | Unambiguous but nearly empty: a pasted global-endpoint session token lives ≤36h, so such a connection breaks within a day regardless. |
| `sts:GetCallerIdentity` probe pinned to the **global** endpoint (`sts.amazonaws.com`) | **Survives its stated counterexample** — boto3#3975 is specific to *regional* endpoints, and the global endpoint cannot be deactivated. STS documents that `GetCallerIdentity` needs no permissions and succeeds even under an explicit `Deny`, closing the whole `AccessDenied`-ambiguity class by construction. Rejected only on prerequisite 1 (no reader), plus: it is blind for this connector's own recommended credential shape — `AWS_ROLE_ARN` is set without `source_profile` / `credential_source` / `web_identity_token_file`, and `external_id` has no env var at all. **This is the candidate to reconsider first** once a reader exists and that gap is closed. |

### 5.2 The alternative that was recommended instead

**Do not auto-mark. Surface collection age and let a human judge.** It states a measured fact
("no successful collection since X"), so it cannot false-accuse a working credential; it
covers strictly more causes than `markAuthFailure` (revoked key, deleted role, powerpipe
uninstalled, steampipe down, broken mod, opt-in misconfiguration, our own decrypt failure);
and it was ~90% built. Three defects were found in review and must be fixed by whoever writes
it:

1. **Write the freshness predicate as an allowlist, never as `NOT ERROR`.**
   `IntegrationExecutionStatus` has seven values, and `NOT ERROR` admits `RUNNING` — the
   opening state of *every* execution. A worker killed between the `create` and the `update`
   (OOM, SIGKILL, eviction) leaves an orphan `RUNNING` row that **resets the freshness clock**,
   so a connection whose collector dies nightly reads permanently fresh. Use
   `status: { in: ['PASSED', 'FAILED'] }`. *(Shipped as
   `docs/implementation-notes/2026-09-10-posture-freshness-status-allowlist.md`.)*
2. **The negated form also blinds the leaver rail.** `leaverPassStatus` returns
   `NOT_APPLICABLE` when the blast-radius breaker refuses a batch — deliberately, so it does
   not inflate `errorCount24h` — and `identity-sync` writes `PARTIAL` for a truncated pass.
   Under `NOT ERROR` a leaver connection whose breaker fires nightly renders green. That is the
   one subsystem here with directory-write blast radius.
3. **Changing `isStale` to key on collections reverses a guarded decision.**
   `tests/guards/p1-connector-parity.test.ts` asserts "health signal reflects activity, not
   only PASSED", and there is no generic scheduled-check dispatcher: `github`, `servicenow`,
   `personnel`, `device` and `training` connections emit an execution only via
   `automation-runner` iterating controls with an `automationKey`. An enabled ServiceNow
   connection with no control wired to it would flip to a permanent red "Stale" badge —
   manufacturing exactly the alarm fatigue this recommendation exists to avoid. It needs a
   third state ("no collection scheduled").

**Accepted residual risk:** a revoked posture credential is still never labelled "revoked".
With the staleness fixes it shows as "no successful collection in N days" plus the 48h OTel
alert — later and less specific than a banner, but **never wrong**.

---

## 6. What survives from the branch as still-correct

Reusable as prior art, independent of any trigger:

- **The auth-vs-authz split** of §1.2, and the excluded sets with their reasons. Any successor
  that classifies text at all needs this list, and it should be *added to* rather than
  loosened. R3 removes `AuthFailure` from it; nothing else in §1.2 was refuted on its own
  terms except GCP `invalid_grant` (§2.3).
- **The credential-hygiene rule**: only an allowlisted *code* may reach `authFailureReason` —
  never raw stderr — because that column is exempt from field encryption and is selected into
  an API payload. This is load-bearing and survives every refutation above.
- **The asymmetry argument** (§3), which is *why* any list stays narrow.
- **The provenance caveat**: the codes are documented API error codes, not observed strings.
  Any reuse must carry it.
- **The `exec` seam** on `AwsPostureProvider`: test infrastructure its Azure/GCP siblings
  already had.
- **`posture-auth-failure-reachability.test.ts`** as a *shape*: it mocks the database and
  nothing else, so the real provider, the real predicate and the real writer compose and what
  is asserted is the row they actually write. The original defect survived because every layer
  was tested against a stub of the next one and the composition was tested nowhere. Main's
  same-named file is the logical negation of the branch's and is the one to read.

---

## 7. Artefacts and citation dates

| Thing | Where |
| --- | --- |
| The abandoned commit | `4d891b6acaca70ac0d5826f9ec949e596a87cfd5` — local refs `fix/posture-auth-failure-unreachable` and `fix/2252-posture-auth-trigger`; **deleted from origin**. Not fetchable from a fresh clone. |
| The classifier source | Reproduced in §1.2. The full 169-line module with its prose is readable from that commit object wherever it is still reachable. |
| The refutations | #2252, comments of 2026-09-04. |
| The withholding reasons in code | `src/app-layer/usecases/aws-posture.ts:196-211`; `src/app-layer/usecases/cloud-posture.ts:175` ff. |
| Executable form of R1 / R2 / R3 | `tests/unit/posture-credential-classifier-refutation.test.ts` |
| Prior art for the same shape, shipped | `docs/implementation-notes/2026-08-18-oauth-400-credential-classification.md`, `src/app-layer/integrations/oauth-token-fetch.ts` |

Every `file:line` above was re-derived against `main` on **2026-09-19**. This is a
moment-in-time record: a drifted line number proves the *citation* moved, not that the *claim*
changed — re-derive by symbol name before concluding anything from a miss.
