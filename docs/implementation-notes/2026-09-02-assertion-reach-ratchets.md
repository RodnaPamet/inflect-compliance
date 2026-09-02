# 2026-09-02 — assertion-reach ratchets (issue #2246, classes C and D)

**Commit:** `<pending> test(guardrails): ratchet the two assertion-reach defect classes from #2246`

## Design

#2246 records a family of defects with one sentence in common: **an assertion
whose reach is not the thing it names.** Classes A and B were closed for the
sites that were named; the issue was then reopened because closing named sites
is not closing a class. Two of the remaining members are mechanically
detectable, and this change turns each into a downward ratchet.

```
                    tests/helpers/assertion-reach.ts
                    ─────────────────────────────────
     git ls-files ──►  repoFiles({under:'tests'})            (population)
                          │
                          ▼
                   ts.createSourceFile (syntax only, cached)
                          │
                          ▼
                   collectExpectSites()                       (the denominator)
                    expect(<subject>)[.not].toMatch|toContain(<arg>)
                       │                          │
        ┌──────────────┘                          └───────────────┐
        ▼                                                          ▼
  recoverPattern(arg)                                    resolveSubject(subject)
   regex literal │ const-bound regex │ new RegExp(`…`)     readPrismaSchema() │
        │        analysed / skipped-with-reason            readFileSync(path.join(ROOT,'x'))
        ▼                                                  local read('x') │ codeOf(…)
  analyseSpans(pattern)                                            │  analysed / skipped-with-reason
   any-char class + quantifier + interiority                       ▼
        │                                                  recoverNeedle(arg) → count(text)
        ▼                                                          │
  Class C ratchet                                                  ▼
  assertion-span-reach-ratchet.test.ts               Class D ratchet
                                                     assertion-needle-uniqueness-ratchet.test.ts
```

**Class C — a regex span that crosses out of the block it is about.**
`[\s\S]*` / `[\s\S]*?` written BETWEEN two pieces of pattern claims a
relationship it does not enforce: the span re-forms across a sibling block, so
deleting the thing under test leaves a neighbour satisfying the assertion.
Both hand-proved instances (`audit-s1-residual-and-mitigated.test.ts:115`,
`risk-quantitative-analytics.test.ts:94`) stayed fully green under a mutation
that removed exactly what the test was named for.

**Class D — a needle that occurs more than once in what is read.** An
assertion reads a whole file and matches a string with several satisfying
positions. The detector reproduces all three hand-proved instances with the
issue's own multiplicities: `frameworkKey String` ×3, `@@index([tenantId])`
×15, `.toContain('model VendorEvidenceBundle')` ×2. `.toContain` is in scope
because the third instance is one — the matcher is where the class hid during
the previous round.

Neither is a hard ban. 182 and 1575 sites are not landable as an error, and
fixing them is not this change; the value is stopping the growth and making
each reduction visible.

## Measured populations

Over 2,195 files git lists under `tests/`:

| | Class C | Class D |
|---|---|---|
| sites examined | 8,464 `toMatch` | 11,882 `toMatch`/`toContain` |
| in the class's scope | 8,464 | 6,132 whole-file reads |
| analysed | 8,405 (99.3%) | 5,739 (93.6%) |
| skipped, with a named reason | 59 | 1,392 |
| **findings** | **182** unbounded interior spans (383 interior of any boundedness) | **1,575** ambiguous needles (276 at ≥5 occurrences) |

## Files

| file | role |
|---|---|
| `tests/helpers/assertion-reach.ts` | the analyser — parse, collect `expect` sites, recover patterns/needles, resolve a subject to file text, classify spans, count occurrences. Returns findings AND skips-by-reason. |
| `tests/guardrails/assertion-span-reach-ratchet.test.ts` | Class C: three ceilings + drift sentinels + a synthetic detector proof + direct tests of the span classifier. |
| `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` | Class D: three ceilings + drift sentinels + a synthetic detector proof + a by-name check of the three instances #2246 proved by hand. |
| `CLAUDE.md` | new "Assertion-reach ratchets" subsection under the codebase-hygiene ratchets. |

## Decisions

- **AST, not grep — and the difference is the issue's own subject.** #2246's
  numbers came from `grep 'toMatch' | grep '\[\\s\\S\]\*'`, which can only see
  an assertion whose regex prettier happened to leave on the matcher's line.
  Reproduced exactly (the grep still says 86 over `tests/guards` +
  `tests/guardrails`), the AST says 126 over those same two directories and
  182 over all of `tests/`. Enumerating a second way is what found the
  residual, which is precisely the practice the issue asks for.

- **The population is all of `tests/`, not the two directories the issue
  measured.** The defect has nothing to do with which directory a file sits
  in, and one of Class D's three proved instances is in `tests/integration`.
  Scoping to a directory list would be a hand-maintained denominator.

- **Population from git (`repoFiles`), never a directory walk.**
  `tests/guardrails/source-scan-population.test.ts` forbids the walk and
  carries no allowlist; it exists because a guard once read
  `.claude/worktrees/<id>/`'s copy of itself.

- **Each detector reports its own denominator, and the skip count is
  ratcheted too.** A detector that silently drops what it cannot parse has its
  own parseability as its denominator and then reports full coverage of the
  subset it understands — the same defect one level up from the one being
  detected. So `analysed + skipped == sites` is asserted as an identity, the
  skips are capped, and the analysed SHARE has a floor (a skip ceiling alone
  can be satisfied by deleting assertions). Measured consequence: planting
  `expect(src).toMatch(build('Tenant'))`, where `build` returns a spanned
  regex the analyser cannot follow, turns the Class C skip ceiling red rather
  than evading the ratchet.

- **A second, wider ceiling on Class C so the headline cannot be bought.**
  201 of the 383 interior spans are already character-bounded
  (`[\s\S]{0,200}`), so rewriting `*?` as `{0,200}` is one search-and-replace
  away and would drop the unbounded count while leaving the assertion just as
  unbound to the block it names. Capping the total makes that rewrite
  neutral — it can register as the partial improvement it is, never as
  headroom.

- **Lexical scope resolution, not a flat file index.** The dominant idiom is a
  per-test `const schema = read('…')`, written again in the next `it`. A flat
  index sees the name twice, calls it ambiguous and drops both sites — and one
  of the sites it drops is `entra-ei2-group-mapping.test.ts:18`, one of the
  three instances the issue proved by hand. A detector that cannot see its own
  worked example is measuring its parser, not the tree. The three proved
  instances are therefore also asserted BY NAME, so a future refactor of the
  analyser cannot quietly stop resolving them while the aggregate counts stay
  plausible.

- **A regex needle is counted by running it globally, not by restricting the
  detector to metacharacter-free strings.** `/@@index\(\[tenantId\]\)/` has
  metacharacters and fifteen satisfying positions; that IS the finding.
  Regexes carrying an unbounded span are excluded and reported as
  `needle-carries-span` — a greedy span collapses every candidate into one
  match, so a count there would be meaningless, and those sites already belong
  to Class C.

- **`DRIFT_ALLOWANCE = 0`, against the repo's older ratchets (2 to 10).**
  Those count token occurrences across ~1,500 UI files, where ordinary work
  moves the number incidentally. These numbers move only when somebody writes
  or deletes an assertion of a specific shape. An allowance would not buy
  quiet, it would buy exactly the headroom the sentinel exists to remove.

- **Class D will sometimes fire on a diff that changes no test.**
  `.toContain('model VendorEvidenceBundle')` was unambiguous when written and
  became a tautology when `VendorEvidenceBundleItem` was added to the same
  schema file. That event is the one nobody was being told about, so surfacing
  it is the feature, not the noise.

- **No allowlist, on either ratchet.** An inline `// allow:` escape hatch
  would be the cheapest way back to green and would recreate the "keep the
  note, drop the code" shape the issue is about. The ratchet's answer to a
  deliberate multi-occurrence assertion is that adding one comes with removing
  one; the population only moves down.
