# 2026-09-11 — #2246 Class B: enumerate the derived-value population, then guard the fixture

**Commit:** see `fix/2246-class-b-fixture-arms`

Class B of #2246 is one sentence: *a derived value is byte-identical to a constant
in scope, so no assertion can separate them.* The filed instance was
`cloud-posture.ts` — it takes a `cloud` parameter and every test passed
`'azure-posture'`, so at runtime the parameter and the hard-coded literal were the
same string and replacing `input.cloud` with the literal survived at every site,
at 100 % branch coverage.

#2245 and #2266 closed it with a **fixture**, not with assertions: both collector
suites run over an ARM TABLE that pairs a cloud with its own benchmark, ids, clock
and secrets, so a literal written at any consuming site fails the arm it does not
name. That is the right shape. What was missing is the half that keeps it true.

## Design

### The class stated before enumerating, and enumerated two ways

The issue's own root cause is that both prior rounds *enumerated by the previous
bug's name* — `grep input.cloud` returns 13 hits; an AST walk of the same file
returns three figures larger than that and none of them is 13. So the population
was defined as a predicate and measured twice, independently.

**Method 1 — a value-position AST walk.** A SITE is every expression in a value
position: any node a hard-coded literal could be written in place of without
changing the shape of the program. Composites are recorded *and descended into*
(`decryptField(x)` is one substitutable value; `x` is another) — the same
correction the round-two comment in the suite records, applied from the start.
Excluded, because a literal cannot occupy them: type annotations, import
bindings, property *names*, assignment targets (all operators, `+=` and `++`
included), callee subchains (`db.evidence` in `db.evidence.create(…)`), and
property-access receivers.

| | cloud-posture.ts | aws-posture.ts |
|---|---|---|
| value-position sites | **241** | **249** |
| …derived (input-dependent) | **192** | **189** |
| …constant (literal / module const) | 49 | 60 |
| distinct literal constants in the file | 32 | 33 |

The issue quotes 103 and 94; the suite's own comment quotes 111 then a corrected
141. This walk is a superset of all three — it scores every nesting level of a
composite and both files' `await`/call/`as`/parenthesised wrappers. The number is
not the point; the *predicate* is, and it is written down so the next reviewer
can disagree with it precisely.

**Method 2 — observe, do not reason.** Every derived site was wrapped in a
type-preserving probe `__P<T>(id, v): T` that records each DISTINCT value the
site takes, and the four posture suites (105 tests) were run against the
instrumented collectors. A site whose observed value set is a **singleton** is a
Class-B instance by definition: one literal is byte-identical to it at every
observation the suite makes, so nothing the suite asserts can separate the two. A
site with two or more observed values is distinguishable *by construction*.

| | cloud-posture.ts | aws-posture.ts |
|---|---|---|
| derived sites | 192 | 189 |
| never reached by the suites | **0** | **0** |
| two or more observed values → distinguishable | 167 | 164 |
| ONE observed value → candidate | 25 | 25 |

The 50 candidates, classified — and this is the result that matters:

| bucket | count |
|---|---|
| a promise (or `{}`) returned by an async mock — no scalar to name | 32 |
| a DISCARDED statement result: `await markAuthFailure(…)`, `await clearAuthFailure(…)`, `logger.info(…)`, both link `create`s — the value flows nowhere | 10 |
| a non-scalar object: the `db` transaction handle, `new Set<string>()`, `new AwsPostureProvider()` | 6 |
| a function reference (`Error`) | 2 |
| **a SCALAR with a single observed value** | **0** |

So: **zero string-, number- or Date-valued derived expressions in either
collector are byte-identical to a single constant across the suites.** The four
names the issue lists — `c.id`, `checkResult.status`, `evidenceCreated`, `now` —
each take two or more observed values, and each was mutation-proved individually
(below). The arm tables did their job; nothing was keeping them doing it.

### The gap that was real: nothing guarded the fixture

The tables were file-local `const`s. The only check on their values was one
hand-written assertion about one axis (`wallSkew`) out of twenty-one, and an axis
added later inherited nothing. That is exactly the failure the issue records for
this lane — *round two changed one fixture value and thereby MOVED the
coincidence rather than removing it* — and it was still unguarded.

And it was not hypothetical. Measured on `main`: **arm 0 of both tables was
`benchmark: 'soc2'`, byte-identical to the collectors' own default literal in
`String(config.benchmark ?? 'soc2')`.** For the whole of that arm the derived
`check` and the source constant were the same string; only the other arm's `CIS`
was keeping any site honest. Both arm 0s are now `Soc2Type2` / `soc2type2`,
which also means `.toLowerCase()` is exercised on both arms rather than being the
identity on one.

### The forward guard

`tests/helpers/posture-collector-arms.ts` holds both arm tables — moved out of
the suites for one reason: so a guard can read them.
`tests/guards/posture-fixture-arm-distinctness.test.ts` asserts the property over
every axis at once, derived from the tables rather than from a list of names:

- **P1** every AXIS is pairwise distinct across arms.
- **P2** no arm SCALAR is byte-identical to a literal constant in the collector
  source it drives. Literals come from a `ts.createSourceFile` walk, never a
  regex: both collectors *discuss* `'azure-posture'`, `soc2` and `PASSED` at
  length in comments, and a text scan would fail P2 on prose — Class A of this
  same issue is precisely that defect, and the AST cannot see a comment.
- **P4** no scalar anywhere in one arm appears anywhere in another. Strictly
  stronger than P1, because a coincidence can cross axes: `arm0.exec` equal to
  `arm1.conn` re-welds two derivations that P1 reads as distinct.
- **P3** the selections P1, P2 and P4 run over are non-empty, and the arms agree
  on their axis set. Each of the other three is a loop over a filtered set, and
  **an empty selection is a pass** — P3 is the only thing standing between them
  and vacuity.

A `Date` axis flattens to three scalars, because the collectors derive three
things from the injected instant: the ISO string, the day cut out of it, and the
epoch milliseconds.

Two written allowlists, each with a staleness test that refuses an entry which is
no longer a real collision. `SHARED_AXIS_EXEMPTIONS` is empty.
`SHARED_SCALAR_EXEMPTIONS` has exactly one member — `CC7.1` in the AWS table's
`trailingCodes`, where both arms deliberately land on one SOC 2 code so every
framework-resolution assertion holds unchanged under either arm; the arrays still
differ, so no single literal is byte-identical to either arm's value.

## Files

| file | role |
|---|---|
| `tests/helpers/posture-collector-arms.ts` | both arm tables, exported so a guard can read them; arm 0's benchmark moved off the collectors' `'soc2'` default |
| `tests/guards/posture-fixture-arm-distinctness.test.ts` | P1–P4, the two allowlists, their staleness tests, and the mutation proofs in its docstring |
| `tests/unit/usecases/cloud-posture-collection.test.ts` | table replaced by the import; the `wallSkew` axis test kept as a second detector and pointed at the general one |
| `tests/unit/usecases/aws-posture-collection.test.ts` | same |

## Decisions

- **The suites' own `wallSkew` axis test was kept, not replaced.** It is a live,
  independent detector for the axis it names, and deleting a working detector in
  favour of a new one is how a class survives a round. It now says in its
  docstring that it covers one axis of twenty-one and where the general form
  lives.

- **P4 is not redundant with P1, and that was measured rather than argued.**
  Setting `arm1.conn` to `arm0.exec`'s value fails P4 and leaves P1 GREEN.

- **The claim that the guard covers axes that do not exist yet was proved, not
  asserted.** A brand-new axis added to both cloud arms with one shared value
  fails P1 and P4, both naming it. A new axis added to ONE arm only fails P3's
  axis-set agreement check and nothing else — that is the quiet case, because
  the missing side reads `undefined`, the flattener drops it, and the axis stops
  being compared at all.

- **The probe harness was not committed.** It rewrites both collectors in place,
  needs `ts-jest` diagnostics off, and would sit inside `eslint .`'s scope for no
  ongoing benefit. The durable artefact is the guard; the harness is described
  above in enough detail to rebuild, and the numbers it produced are recorded
  here rather than left in a workflow transcript.

- **Diagnostics were disabled for the mutation sweep on purpose.** The question
  a mutation answers is what the ASSERTIONS catch. `tsc --noEmit` is a separate
  detector and is run separately; counting a type error as a kill would have
  credited the assertions with work the compiler did.

- **What remains open.** The literal-substitution operator is closed for scalar
  derived values in both collectors, and P1–P4 keep it closed. The
  *equivalent-derivation* operator is not the same question and is not closed —
  the suites' own comments enumerate 67 surviving swaps and triage them as
  identities or as states a type-correct fixture cannot reach (`String(x)` for
  `` `${x}` ``, `conn.id` for `input.connectionId`, `.toLowerCase()` for
  `.toLocaleLowerCase()` which needs a Turkish ICU locale to separate). Those are
  a different class from the one this issue names, and no guard here claims them.
