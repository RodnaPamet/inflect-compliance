# 2026-08-24 — custom ESLint rule infrastructure (`eslint-rules/`)

**Commit:** `a6fd69cbc` chore(lint): stand up custom ESLint rule infrastructure

## Design

CLAUDE.md's epic-ratchet-lifecycle section tells contributors to write an
ESLint rule rather than a regex guard whenever the invariant is structural.
The repo had no local plugin and no `eslint-rules/` directory, so the
instruction was unfollowable: every structural rule kept landing as another
`readFileSync` + regex under `tests/guards/`, and two of them
(`no-inline-clipboard`, `date-input-rollout`) had already been migrated into
`no-restricted-syntax` selectors in `eslint.config.mjs` — the ceiling of what
a selector alone can express.

```
eslint.config.mjs
  └─ import localPlugin from './eslint-rules/index.js'   (CJS → ESM interop)
       └─ plugins: { local: localPlugin }
            └─ rules: { 'local/no-fail-open-teardown-filter': 'error' }

eslint-rules/
  index.js                        plugin object
  rules/<name>.js                 one rule per file
  __tests__/<name>.test.ts        ESLint RuleTester, run by Jest's node project
  README.md                       when a rule belongs here vs tests/guards/
```

The rule that earns the infrastructure is `no-fail-open-teardown-filter`, the
regression class from #2107 / #2113 / #2114. Jest runs `afterAll` even when
`beforeAll` threw, so a fixture id held in a bare `let` is still `undefined` in
teardown on any setup failure — and Prisma DROPS an undefined filter value
rather than rejecting it, turning `deleteMany({ where: { tenantId: tenantA } })`
into an unpredicated `DELETE` against a database every suite in the run shares.
It does not throw. It succeeds, so the surrounding `try { … } catch` never
fires and the run stays green. Fourteen sites were fixed by hand across two PRs
and nothing stopped the sixteenth.

The rule needs scope resolution (is this identifier a `let` with no
initializer?) and cross-node reasoning inside the file (is the call inside an
`if` testing *that same* variable?). Neither fits an esquery selector, which is
precisely why it justifies a rule file rather than another entry in
`no-restricted-syntax`.

## Files

| File | Role |
| --- | --- |
| `eslint-rules/index.js` | The plugin object registered as `local`. Carries the module-format rationale. |
| `eslint-rules/rules/no-fail-open-teardown-filter.js` | The rule. Header documents the measured Prisma behaviour and, at length, what the rule cannot see. |
| `eslint-rules/__tests__/no-fail-open-teardown-filter.test.ts` | RuleTester: 12 valid + 11 invalid cases, plus a parser-in-play assertion. |
| `eslint-rules/README.md` | Contributor guide: layout, module format, rule-vs-guard-vs-selector decision, how to add one. |
| `eslint.config.mjs` | Imports and registers the plugin; turns the rule on at `error`. |
| `CLAUDE.md` | The epic-ratchet section said "write an ESLint rule instead" without naming a location; now points at `eslint-rules/README.md`. |
| `tests/integration/{automation-event-flow,business-impact-analysis,scanner-ingestion,vendor-doc-extraction,vendor-monitoring}.test.ts` | The 12 live violations the rule found on its first run, guarded. |

## Decisions

- **CommonJS `.js`, and it was not a free choice.** `.mjs` was tried first and
  fails: TypeScript treats a `.mjs` file as ES-module format unconditionally
  and will not downlevel it to CommonJS, so ts-jest hands Jest untransformed
  `export` syntax and every rule test dies with
  `SyntaxError: Unexpected token 'export'`. Rules that cannot be tested defeat
  the point of having a home for them. `.cjs` fails differently and is a known
  repo trap: `eslint.config.mjs` applies `react-hooks/*` to all files but
  `eslint-config-next` only registers that plugin for its own scope, which
  excludes `.cjs`, so the Lint job fails with "could not find plugin
  react-hooks". `package.json` declares no `"type"`, so `.js` is CommonJS and
  loads from the ESM config (interop), from Jest (require), and from ESLint
  alike. Verified all three, not assumed.

- **The rule is BIASED toward flagging, but it does not fail closed as an
  absolute** — the first draft of this note claimed it did. Three shapes were
  measured failing OPEN and are now fixed: a negated guard (`if (!x)`, strictly
  worse than no guard), `AND`/`NOT` combinator arrays, and `where: <bare let>`.
  Two remain open and are listed in the rule header rather than glossed:
  non-identifier filter values, and reachability. Whether a variable
  is assigned on every path reaching the `deleteMany` is a data-flow fact and
  this rule does no data-flow analysis. It recognises exactly one guard shape —
  the call in the truthy branch of an `if`/ternary testing the same variable,
  or the right of an `&&` testing it. An early return (`if (!id) return;`) is a
  correct guard that the rule flags anyway. That false positive is pinned as a
  named `invalid` case in the test file so a future reader sees it was a
  decision, not an oversight. A false positive costs one `if (…)`; a false
  negative costs a table in a shared database.

- **Flags the `{ in: <identifier> }` shape that has no live instance.** An
  array *literal* (`{ in: [a, b] }`) is safe — Prisma validates members and
  throws on an undefined element — and is not flagged. An identifier standing
  for the whole array is dropped exactly like a bare scalar and IS flagged.
  #2114 recorded that trap without a live example precisely because
  spot-checking the two safe `in` shapes leads to the wrong conclusion that
  wrapping in `in` is the protection. The rule is where that finding becomes
  enforcement.

- **The rule found 12 more live instances the two hand-sweeps missed, and they
  are fixed in this diff.** #2113 fixed one site and #2114 fixed fourteen; the
  first full-repo run of this rule reported 12 more, in five files
  (`automation-event-flow`, `business-impact-analysis`, `scanner-ingestion`,
  `vendor-doc-extraction`, `vendor-monitoring`), every one a bare
  `let tenantId: string;` read straight into a teardown `deleteMany` inside the
  same useless `try { … } catch { /* best-effort */ }`. Unpredicated, they would
  have emptied `AutomationExecution`, `AutomationRule`, `BiaDependency`,
  `BusinessImpactAnalysis`, `ScannerFinding`, `ScannerRun`, `Finding`,
  `VendorAnswerProposal`, `VendorDocExtraction`, `VendorAssessmentAnswer`,
  `VendorPostureEvent` and `VendorMonitor` for every tenant in the run's
  database. They are true positives, not calibration noise, so they are guarded
  here with the repo's own `if (tenantId) { … }` idiom rather than being
  deferred. This is the concrete argument for the infrastructure: a mechanical
  AST sweep found in one run what two careful hand-audits did not.

- **`error`, not `warn`.** After those 12 fixes the full-repo lint is `0 errors,
  245 warnings` — exactly the warning count on `main`, so the rule adds no
  noise and `error` costs a clean tree nothing. `warn` would also have been
  invisible: `npm run lint` is `eslint .` with no `--max-warnings`, so a warning
  does not fail CI and the repo already carries 245 of them.

- **`@typescript-eslint/parser` is reached through the repo-wide `overrides`
  pin rather than being added to `devDependencies`.** Adding it at the same
  literal range the override already carries is the shape that aborts a whole
  Dependabot run — the `"$name"` idiom exists to avoid it — and it would mean
  regenerating `package-lock.json`. The test asserts the parser is really in
  play (it parses `let x: string;`, which espree cannot), so if the tree ever
  stops providing it the failure names the cause instead of surfacing as two
  dozen "Unexpected token :" parse errors.

- **No existing guard was deleted.** The obvious migration candidate,
  `tests/guards/detail-page-back-prop-ban.test.ts`, is a UI-convention ban
  whose regex has a genuine defect (`<(?:EntityDetailLayout|PageHeader)\b[\s\S]*?(?:>|/>)`
  stops at the first `>`, so a `back={{ href }}` after an arrow-function or
  nested-JSX attribute is missed). Migrating it is a real improvement and a
  separate diff: it changes which files are flagged, and bundling a
  behaviour-changing migration into the PR that stands up the infrastructure
  would make both harder to review. The README records the decision rule so
  the next contributor does not have to rediscover it.

- **The rule catches a different class from `tsc`, unlike the other candidate
  considered.** A rule for the `jest.fn(async () => …)` / `mock.calls[0][0]`
  TS2493 shape was measured first: a probe file confirmed `tsc --noEmit`
  already reports it on the zero-parameter form and correctly stays silent on
  a declared-parameter or `jest.Mock`-annotated one. A lint rule there would
  restate what the type checker already says. The teardown shape has no type-
  level signal at all — `undefined` is a legal `where` value — so lint is the
  only place it can be caught.
