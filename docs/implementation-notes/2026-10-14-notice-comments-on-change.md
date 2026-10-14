# 2026-10-14 — the main-CI notice comments only when something changed (#3540)

**PR:** #3553 · **Issue:** #3540 · **Builds on:** #3505 /
`2026-10-14-main-ci-failure-notice.md`

## The defect, found by the thing working

The notifier shipped in the morning and was exercised in production the same
day: it opened #3534, updated it five times, and closed itself on green. That
is the design working — and it is also how the defect surfaced. Those five
updates each carried a **"Still failing" comment**, identical but for the run
id, for one cause. An issue whose history is five copies of one line is an
issue people stop reading, which is precisely the failure mode #3505 exists to
avoid. A notifier can fail by being ignored as well as by being silent.

## The fix, and the part that is easy to get wrong

The body is rewritten **every** run; only the comment is conditional. It fires
when the failing job set differs from the last recorded one, and names both.

**Suppressing comments loses information on its own.** Five comments did at
least say five runs had failed; silence says nothing. So the stored state is
not a bare fingerprint — it carries a consecutive-run count and the commit the
streak started at, and the body states both:

> **5 consecutive runs** have failed with this job set, since `abc1234`.

The close-on-green comment now reports what the outage cost ("It had failed 5
consecutive runs since `abc1234`"), which is the payoff for storing a count
rather than a hash.

The store is an HTML comment in the issue body this workflow already rewrites
every run — no external state to go stale, no extra API call, and invisible in
rendered Markdown.

## Four decisions

- **Absence comments.** A missing or unparseable marker returns `null`, read
  everywhere as *cannot prove it is unchanged*. Defaulting the other way would
  swallow the first comment after this ships and every comment after a human
  edits the body — silence exactly when it knows least. Both cases have their
  own test, and inverting the default fails five.

- **The set is a SET.** Sorted and de-duplicated, because
  `listJobsForWorkflowRun` promises no ordering. An unsorted join would comment
  on every run *while claiming the set had changed* — louder than the behaviour
  it replaced **and** lying about why.

- **`>` is stripped from the fingerprint.** Job names are text this repo does
  not fully control, and a literal `-->` in one would terminate the HTML
  comment early, rendering the rest of the marker into the body as visible
  garbage. Two names differing only by a `>` then collide, which costs one
  missed comment and cannot corrupt anything — the right direction for the
  trade to fall.

- **An empty set gets a sentinel.** A run can fail with every job green (setup,
  billing). Without `(no failing job named)` the empty fingerprint would
  compare equal to a missing marker's and two distinct states would collapse.

## The tests RUN the script

Every other assertion in `ci-pipeline-integrity` greps the workflow's text.
That is the right instrument for *"does it trigger on the name `ci.yml`
declares"* and useless here: the property is **how many times `createComment`
is called across two runs**, and no needle can see that. So the script is
lifted out of the YAML with `new Function` and executed against a recording
double of `github`.

`new Function` is confined to tests, and that was **checked rather than
assumed** — both guards banning in-process evaluation
(`csp-script-guardrails`, `tool-execution-is-bounded`) scope their populations
`under: 'src'`.

### Nine mutation proofs

| mutation | result |
| --- | --- |
| always comment | **3 fail**, incl. the headline regression |
| skip the body update too — the obvious wrong way to comment less | 3 fail |
| drop `.sort()` | 1 — API order fakes a change |
| read absence as unchanged | **5** — the no-issue path throws outright |
| drop the `>` strip | 1 — marker corrupted |
| drop the count line | 1 — commenting less becomes saying less |
| restamp `since` every run | 2 — the count loses its anchor |
| drop the empty-set sentinel | 1 |
| interpolate `prev` on the green path | 1 — "undefined consecutive runs" |

## Two things checked rather than hoped for

- **The five #3505 needles were re-counted** after the edit and each still
  occurs exactly once in the script. That file's own history is two Class D
  ambiguity defects — `issues.update` appears twice, and `issues.create` is a
  prefix of `issues.createComment` — so this is verified every time the script
  changes, not once.

- `NOTICE` / `notice` / `script` were **hoisted to module scope** so the new
  block reuses the same parse rather than adding a second whole-file read. The
  Class D needle-uniqueness ratchet runs at zero drift allowance, so an
  incidental second read is not free.

## Risk

Worst case is a missed comment, never a missed issue: the issue still opens on
the first red run, the body still updates every run, and it still closes itself
on green. Every path that cannot prove the set unchanged comments.
