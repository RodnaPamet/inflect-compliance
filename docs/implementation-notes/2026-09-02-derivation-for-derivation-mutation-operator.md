# 2026-09-02 — the derivation-for-derivation mutation operator on the posture collectors

**Commit:** see the commit that carries this file — `test(posture): tell the wall
clock apart from the injected instant, and run the derivation operator`

## Design

The two posture collector suites
(`tests/unit/usecases/cloud-posture-collection.test.ts`, `…/aws-posture-collection.test.ts`)
had been hardened over several rounds against one mutation operator: **substitute
a LITERAL for an expression**. The two-arm `describe.each` table is the remedy for
that operator — a value that appears once in a fixture is byte-identical to a
literal at runtime, so running every assertion under two disjoint fixture sets
means whichever value a hard-coded literal names, the other arm fails.

That operator cannot see a different family: **substitute one derivation for an
EQUIVALENT derivation**. Both arms move together, so no amount of arm-varying
separates `Date.now()` from `now.getTime()` when the fixture makes them the same
number.

They were the same number. `const fakeClock = () => fakeClockFor(NOW)` seeded the
mocked wall clock from the very instant injected as `input.now`, so inside every
test that froze the clock, `Date.now()` and `now.getTime()` were equal by
construction. Eight sites across the two collectors could therefore be rewritten
as a reading of the other value with all suites green.

The fix is one line per file — seed the wall clock at `NOW + wallSkew`, with
`wallSkew` a non-zero value unique to each arm.

### The coupling that makes this non-obvious

`completionInstant(now)` is an asymmetric matcher demanding BOTH `v > now` (the
injected instant) and `|v − realNow()| < 5 min` (the *unmocked* clock). Two tests
per file install the fake clock AND assert `COMPLETION_INSTANT` on the same
object as a frozen `durationMs`. Moving the clock base naively would have broken
that matcher or made it vacuous.

It holds — before and after — for a reason worth writing down, because it is what
makes the whole fixture work:

> `jest.spyOn(Date, 'now')` replaces ONLY `Date.now`. `new Date()` with no
> arguments reads the host clock directly and never consults it.

Measured under this jest config: with `Date.now` pinned to `1772366400000` (the
2026-03-01 fixture), `new Date()` returned `1788360457703` — equal to a `Date.now`
reference captured before the spy. So `durationMs` (built from `Date.now()`) is
frozen while `completedAt` (built from `new Date()`) stays on the real clock, and
`completionInstant`'s proximity check is as meaningful after the change as before.
`durationMs` is a *difference*, so the skew does not move it either.

## Files

| File | Role |
| --- | --- |
| `tests/unit/usecases/cloud-posture-collection.test.ts` | `wallSkew` per arm (7 s / 13.5 s); wall clock seeded off `NOW`; 1 new case + 1 fixture-precondition test + 3 strengthened fixtures; the measured header, `fakeClockFor` note and residual list |
| `tests/unit/usecases/aws-posture-collection.test.ts` | the twin — `wallSkew` 4.25 s / 21.75 s; 2 new cases + 1 fixture-precondition test + 2 strengthened fixtures |
| `src/app-layer/usecases/cloud-posture.ts` | **unchanged** — all mutations restored from file copies |
| `src/app-layer/usecases/aws-posture.ts` | **unchanged** |

Coverage on both collectors is unchanged at 100 % statements / branches /
functions / lines. Tests went 72 → 80.

## Decisions

- **Per-arm skew, not one shared constant.** A shared skew is just another
  file-wide constant for a literal to name. Measured: with both cloud arms skewed
  by the same 7 s (and the precondition assertion deleted so it could not do the
  catching), `durationMs: Date.now() - now.getTime() - 7_000` SURVIVED, 37/37
  green. With distinct skews the same mutation fails.

- **A precondition test, because nothing else can see a zero skew.** Every
  behavioural assertion in both files is satisfied when `wallSkew` is 0 — that is
  precisely the state they shipped in, and it was silent. One assertion per file
  now fails if a future edit re-welds the clocks or gives two arms the same skew.

- **Four fixture closures per file, found by the sweep, not by prediction.** A
  falsy-but-present `benchmark` (`?? ` vs `||`), an empty stored ciphertext
  (`conn.secretEncrypted ?` vs `!= null`), the `{ ...config, ...secrets }` spread
  order (the decrypted secret must outrank the same key in `configJson`), and an
  empty provider `errorMessage` (persists as `null`, not `''`). Most cost no new
  test — a fixture value changed inside an assertion that already existed; only
  the empty-ciphertext case (both files) and the AWS falsy-benchmark case needed
  a new `it`. Tests: cloud 36 → 39, AWS 36 → 41 (a case inside the two-arm
  `describe.each` counts twice; the precondition test sits outside it).

- **The residual is written down rather than rounded to zero.** The previous round
  claimed "undetectable DERIVED values: 0" and that claim was false. 67 of the 103
  swaps still survive; they are grouped by class with a reason in each test file's
  header comment. Two of those classes are honest limits rather than identities:
  `.toLowerCase()` → `.toLocaleLowerCase()` needs the suite re-run under a Turkish
  ICU locale, and (AWS only) `secretVals`' `!!v` filter is observationally equal to
  `v !== undefined` because `scrubAwsCredentials` independently skips any secret
  failing `secret && secret.length >= 8`.

- **The catalogue is in this note, not in a script.** Three consecutive rounds had
  the measuring instrument outside the repo where no reviewer could run it. The
  full list below is the instrument: each row is one line-scoped substitution
  applied alone to the named source line, with both collector suites re-run
  against it. It is a hand-built enumeration, so 82 is a floor, not a proof that
  the population is closed.

## The catalogue — 103 swaps, 36 killed, 67 survived

Harness controls, run first so a green is trustworthy: a literal substitution the
two-arm table must catch (`provider: input.cloud` → `'gcp-posture'`) → KILLED; a
true identity (`String(x)` → `` `${x}` ``) → SURVIVED; a substitution whose search
text is absent → refused, never scored.

### The clock and its neighbourhood (21 swaps)

Measured twice: against `fakeClockFor(NOW)` (pre) and `fakeClockFor(NOW + skew)` (post).

| site | swap | pre | post |
| --- | --- | --- | --- |
| cloud:79 / aws:90 | `const start = Date.now()` → `now.getTime()` | SURVIVED | KILLED |
| cloud:79 / aws:90 | → `+now` | SURVIVED | KILLED |
| cloud:79 / aws:90 | → `now.valueOf()` | SURVIVED | KILLED |
| cloud:91 / aws:102 | catch `Date.now() - start` → `Date.now() - now.getTime()` | SURVIVED | KILLED |
| cloud:147 / aws:168 | done `Date.now() - start` → `Date.now() - now.getTime()` | SURVIVED | KILLED |
| cloud:128 / aws:147 | create `dateCollected: now` → `new Date(start)` | SURVIVED | KILLED |
| cloud:91 / cloud:147 | `Date.now() - start` → `now.getTime() - start` (first operand) | KILLED | — |
| cloud:94 | `markAuthFailure(…, now, …)` → `new Date(start)` | KILLED | — |
| cloud:118 | `new Date(now.getTime() + …)` → `new Date(start + …)` | KILLED | — |
| cloud:119 | `now.toISOString()` → `new Date(start).toISOString()` | KILLED | — |
| cloud:125 / aws:144 | update `dateCollected: now` → `new Date(start)` | KILLED | — |
| cloud:147 | `Date.now() - start` → `Date.now() - now.getTime() - 7_000` | — | KILLED (SURVIVED on a shared skew) |

The already-KILLED rows matter as much as the survivors: those sites are also
asserted in tests that install NO fake clock, so `start` there is the real clock,
hours from the fixture. Only what is asserted *exclusively* inside a `fakeClock()`
test was exposed — which is why the hole was four sites per file and not fifteen.

### The systematic pass (82 swaps, 41 per file)

KILLED by the suites as they stood — `executedAt: now` → `new Date(Date.now())`;
`completedAt: new Date()` → `new Date(Date.now())` on both update sites;
`evidenceId: ev.id` → `firstEvidenceId ?? ev.id`.

KILLED only after this round's fixture closures — `config.benchmark ?? 'soc2'` →
`|| 'soc2'`; `conn.secretEncrypted ?` → `!= null ?`; `{ ...config, ...secrets }` →
`{ ...secrets, ...config }`; `checkResult.errorMessage ?` → `!= null ?`. Each was
re-run afterwards and confirmed to fail exactly one test (in both arms), not a
crowd of them.

SURVIVING, grouped — the full reasoning is in each test file's residual comment:

1. **Constant inlining.** `EVIDENCE_FRESHNESS_DAYS * 86_400_000` → `2_592_000_000`;
   `AWS_POSTURE_PROVIDER` → `'aws-posture'` and back.
2. **Equal by construction.** `conn.id` ↔ `input.connectionId`; `ctx.tenantId` ↔
   `input.tenantId` (9 sites measured across the two files); `ev.id` ↔ `existing.id` on the update branch;
   `controlId` ↔ `link.controlId`.
3. **Pure spelling.** template ↔ concatenation ↔ `join`; `String(x)` ↔ `` `${x}` ``;
   `.slice(0, n)` ↔ `.substring(0, n)`; `.slice(0, 10)` ↔ `.split('T')[0]`;
   `x !== 'ERROR'` ↔ `!(x === 'ERROR')`; `+= 1` ↔ `++`; `a = a ?? b` ↔ `a ||= b`;
   `now.getTime()` ↔ `+now`; `raw: automationKey` ↔ the template it was built from.
4. **`??` → `||` where the left side cannot be falsy without being nullish.**
   `input.now` (a Date), `input.provider` (an object), `firstEvidenceId` (a cuid
   or null).
5. **`??` → `||` where the difference needs a type-forbidden value.**
   `conn.configJson`, `summary.counts`, `summary.controls` — all declared
   object-or-nullish. `!link?.controlId` → `== null` needs an empty-string cuid
   foreign key.
6. **Genuinely unreachable through this collector.** The AWS `secretVals` filter
   (see above); `.toLowerCase()` → `.toLocaleLowerCase()` (process locale).

## What this generalises to

The rule the previous rounds were applying — *a fixture value that appears exactly
once cannot be told apart from a constant* — has a sibling that had not been
stated: **two expressions that are equal at runtime cannot be told apart from each
other, and varying the fixture per arm does not help, because both arms move
together.** Separating them requires the two expressions to disagree, which is a
change to the *shape* of the fixture, not to its values.

A mutation operator only finds the holes it can express. Reporting "0 undetectable
values" is a statement about the operator, not about the file.
