# 2026-08-29 — the DAST sunset check that could not fire, and the flip it was supposed to force

**Commit:** `(this PR)` fix(dast): make the sunset check compare against the clock, and flip the nightly baseline to blocking

## Design

The nightly ZAP baseline shipped 2026-06-24 as non-blocking "for the first 30
days", with a declared sunset of **2026-07-24**. On 2026-08-29 it was still
non-blocking — 36 days past its own deadline — and CI was green the whole time.

The guard that was supposed to catch this read:

```ts
const sunset = lines.some(
    (l) => /^\s*#/.test(l) && /\d{4}-\d{2}-\d{2}/.test(l) && /fail_action:\s*true/.test(l),
);
expect(sunset).toBe(true);
```

It asserts a comment exists that contains *some* date and the string
`fail_action: true`. It never parses the date and never compares it to anything,
so no passage of time can turn it red. **That is the actual defect** — not the
missed flip, which was only its first symptom. A check incapable of failing is
worse than no check, because the row in CI reads as coverage of exactly the
deadline nobody was watching.

The fix has two halves, and the first one is the deliverable:

**1. A deferral is now a dated claim the clock can refute.** A non-blocking scan
must carry `DAST-NON-BLOCKING-UNTIL: <YYYY-MM-DD>` in its workflow file. The
guard parses it and compares against `new Date()`, failing the day after it
passes; a date >180 days out is rejected as "a way of never deciding", and an
unparseable date is treated as expired rather than as an open deferral. A scan
with no marker must be blocking. A *stale* marker beside an already-blocking
scan also fails, so the two states cannot drift apart.

The arithmetic is exercised against **fixed clocks** (`deferralVerdict(date,
now)` with `now` injected) rather than only against the live markers. Without
that, a population whose dates all sit in the future is indistinguishable from a
comparison that never runs — which is precisely how the old check passed.

**2. The nightly baseline flipped to blocking, on evidence rather than the
calendar.** Verified before flipping, across the three retained nightly runs
(2026-08-26/27/28, all four role matrices, 9 role-scans):

| | live (un-allowlisted) alerts | HIGH+ |
| --- | --- | --- |
| owner / editor / reader / auditor | **0** | **0** |
| weekly full scan (2026-08-23) | **0** | **0** |

Highest observed risk anywhere is Medium, and every alert is an existing
`.zap/rules.tsv` entry. `fail_action: true` fails on any *un-allowlisted* alert,
so that zero is the number that makes the flip safe — a green non-blocking run
proves nothing on its own.

The weekly **full** scan was deliberately NOT flipped: 11 runs with 2 lost to
boot/runner flake is a younger baseline, and an active scan mutates requests, so
its findings vary more run-to-run. It carries a real deferral to 2026-10-11.

**3. A deferral never covers HIGH+.** `.zap/rules.tsv` is a pluginId allowlist
and an `IGNORE` silences that rule at *every* risk level. That is right for the
framework false-positives it was built for and wrong for a High — one line in a
TSV would otherwise turn an injection finding green. `.zap/assert-no-high-risk.mjs`
re-reads the report's `ignoredAlerts` as well as its live `alerts` and fails on
any riskcode ≥ 3, allowlisted or not. It runs on **both** workflows today,
including the deferred one.

A missing or site-less report is also a failure: a scan that produced no report
is indistinguishable from a scan that found nothing, which is the same
ambiguity the old sunset check embodied.

Related: dropping `continue-on-error` matters beyond the findings verdict.
`action-baseline` calls `core.setFailed` on `zap-baseline.py` exit code 3
("could not scan the target") *regardless* of `fail_action`, so
`continue-on-error: true` was additionally masking a scan that never ran as a
green nightly.

Blocking does not gate merges — both workflows are `schedule` +
`workflow_dispatch` only, with no `pull_request` trigger. The
`ci-checks-unreachable-before-merge.json` entries for them are unchanged and
still accurate.

## Files

| File | Role |
| --- | --- |
| `tests/guardrails/dast-workflow-pinning.test.ts` | Rewritten: deferral clock (fixed-clock arithmetic + live comparison), blocking invariant, HIGH+-gate-always-present, allowlist shape |
| `tests/unit/zap-high-risk-gate.test.ts` | Drives the gate through its real CLI + exit code; the load-bearing case is a High that rules.tsv allowlists |
| `.zap/assert-no-high-risk.mjs` | HIGH+ gate; reads `ignoredAlerts` too, fails closed on an unreadable/site-less report |
| `.github/workflows/dast.yml` | Nightly baseline → blocking (`fail_action: true`, `continue-on-error` removed) + HIGH+ step |
| `.github/workflows/dast-full.yml` | Weekly full scan keeps a Medium-and-below deferral to 2026-10-11; gains the HIGH+ step today |
| `.zap/rules.tsv` | Scope-of-an-IGNORE header; 10055 and 10049 reasons now name every sub-alert their pluginId covers |
| `docs/dast.md` | "Gating posture" replaces "Gating posture & sunset"; documents the marker, the flip-on-evidence procedure, and why the mechanism is shaped this way |

## Decisions

- **The guard fails on an expired deferral rather than auto-flipping.** Flipping
  a scan to blocking is a security-posture change that should be a diff someone
  reads. The guard's job is to make the deadline impossible to ignore, not to
  make the decision.
- **180-day cap on a deferral.** Without a ceiling, "move the date" is
  indistinguishable from "never decide" and the marker degrades into the same
  decoration the old comment was.
- **An unparseable date is `expired`, not `active`.** Fail-closed: a typo in the
  marker must not buy an unbounded extension.
- **The deadline day itself is still active** (end-of-day UTC), so a marker
  dated today does not fail until tomorrow — a same-day edit is not punished by
  runner timezone.
- **HIGH+ gated on the deferred workflow too.** The deferral is about allowlist
  tuning noise at Medium and below; there is no version of "we are still tuning"
  that justifies shipping a known High.
- **`10049`/`10055` reasons now enumerate sub-alerts.** A pluginId matches every
  alert the rule emits — `10055` alone covers three differently-named ones — so
  a reason naming a single sub-alert silently under-describes what the entry
  accepts, and grows scope the next time ZAP splits a rule.
- **Did not touch `CLAUDE.md`**, whose Epic-C paragraph still describes the scan
  as "unauthenticated + non-blocking … sunset 2026-07-24"; that file is owned by
  a concurrent change. It is stale on three counts (the scan is authenticated,
  multi-role, and now blocking) and needs a follow-up.
