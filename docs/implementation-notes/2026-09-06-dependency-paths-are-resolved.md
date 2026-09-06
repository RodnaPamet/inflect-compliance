# 2026-09-06 — a dependency's location is resolved, never spelled

**Commit:** `<pending>` test(worktrees): resolve dependency paths instead of spelling them

## Design

Four files located an installed package by spelling out where `node_modules`
would be, rather than asking Node. Three did it by string-joining onto a root
they computed themselves:

```ts
path.resolve(__dirname, '../../node_modules/cmdk/package.json')
path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
path.join(REPO_ROOT, 'node_modules', 'prisma', 'package.json')
```

`path.join` / `path.resolve` are literal string joins. They do no upward walk,
so none of those expressions means "where the package is" — each means "where
it would be if this checkout owned its install". A `.claude/worktrees/<id>/`
checkout has no `node_modules` of its own and resolves upward to the primary
clone at require time, so all three named a path that never exists there. CI has
a single checkout, so the assumption holds there and only there.

The fourth used the Jest-config notation for the same thing, in
`jest.config.js`:

```js
'^react-grid-layout/legacy$': '<rootDir>/node_modules/react-grid-layout/dist/legacy.js',
```

`<rootDir>` is the checkout, so this pointed at nothing in a worktree.

The fix at each site is Node's own resolver. The ratchet is the point of the
change: this was the *second* discovery of the same shape (the first,
`tests/guardrails/next-image-optimizer-disabled.test.ts`, was fixed in place;
`tests/guardrails/vendored-swagger-ui-matches-dependency.test.ts` had already
written the rationale down independently), and two rediscoveries is the tell
that prose was not going to hold it.

### What the four failures looked like

They failed in four different ways, which is the argument for catching the
shape rather than the symptom:

| Site | Symptom in a worktree |
| --- | --- |
| `tests/unit/filter-foundation.test.ts` | plain red assertion — the reported bug |
| `tests/integration/framework-import-cli.test.ts` | `spawnSync` ENOENT → `status: null` → **all 8** tests reporting "expected exit 3, received null". The symptom named the CLI's exit codes and never mentioned a missing binary |
| `tests/guardrails/prisma-major-pin.test.ts` | **green.** An `if (!fs.existsSync(p)) return;` meant to skip a fresh clone turned the wrong path into a silent skip |
| `jest.config.js` | `Test suite failed to run — Configuration error: Could not locate module`. Every rendered suite reaching `DashboardGrid` never ran a single assertion |

The third is the one worth remembering. Measured: with `PINNED_MAJOR` mutated to
a wrong value, the original file was **5/5 green** from a worktree — the only
assertion in it that reads the *installed* tree had stopped running while
reporting a pass. A check that did not run looks exactly like one that passed.

### The detector

`scanPathCalls()` parses each file with `ts.createSourceFile` — syntax only, no
program and no type checker, following the precedent in
`tests/helpers/assertion-reach.ts` — and walks it for **path-bearing calls**:
`path.join` / `path.resolve` (bare or `path.`-received), the `fs` readers, and
the `child_process` spawners. For each one it reduces the argument list to
ordered path pieces, joins them with `/`, and reports the segment following
`node_modules`.

Joining the pieces first collapses the spellings — `path.join(ROOT,
'node_modules', 'prisma', …)`, `path.resolve(__dirname,
'../../node_modules/cmdk/…')` and `readFileSync(ROOT + '/node_modules/next/…')`
— onto one code path.

The reducer follows string literals, template literals, array elements, `+`
concatenation, both arms of a conditional, and an identifier bound in the same
file to a string-literal `const`. Anything else becomes an opaque segment,
which is counted and can never fuse the pieces on either side of it.

#### It was a hand-rolled lexer first, and review broke it three ways

The first version masked comments, strings, templates and regexes with its own
character loop and then bracket-matched the argument list. Three syntaxes
defeated it, and every one of them failed **silently** — no hit, no skip, and a
denominator that shrank without saying so:

| Syntax | What the lexer did | Measured |
| --- | --- | --- |
| `return /^https?:\/\//.test(u) && path.join(ROOT, 'node_modules', …)` | the regex-start heuristic looked back only at punctuation, saw `n` from `return`, and read the `//` ending the regex as a line comment — blanking the real call after it | `hits: [], total: 0` |
| `return /^['"]use client['"]$/m.test(s)` followed by a `path.join` on a **later line** | same miss, but the unrecognised `'` opened a "string" and desynchronised the masking for the rest of the file | `hits: [], total: 0` |
| `const SEG = 'node_modules'; path.join(ROOT, SEG, 'prisma')` | parsed and was counted, but contributed no string literal | `hits: [], total: 1` |

The first of those is precisely the `codeOf` defect the hand-rolled lexer had
been written to avoid, reintroduced one heuristic later — which is the argument
for the parser rather than a fourth heuristic. A lexer that has to *guess*
whether `/` opens a regex will keep having this bug; TypeScript's parser does
not guess, because it knows the grammar position. All three are now regression
pins in the mutation proof, written as POSITIVE assertions because the failure
mode they guard is silent under-reporting.

`node_modules/.cache/**` is allowed. That is a statement about what the path
*means*, not an allowlist entry: it is a per-checkout scratch directory this
repo creates and writes (the test-DB per-worker marker, the E2E TLS cert). The
writer owns it, resolution does not, and it must stay per-checkout — two
worktrees sharing one marker would point each at the other's databases. The file
carries no exemption list.

## Files

| File | Role |
| --- | --- |
| `tests/guardrails/dependency-paths-are-resolved.test.ts` | new ratchet over the code this repo loads from its own checkout — `tests/` + `src/` + `scripts/` + `eslint-rules/` + `__mocks__/` + `prisma/` + `scratch/` + `.zap/` + the repo-root files; exports the detector so the mutation proof can drive it on synthetics |
| `tests/unit/filter-foundation.test.ts` | resolves `'cmdk'` and `'motion/react'` — the specifiers `src/` actually imports |
| `tests/integration/framework-import-cli.test.ts` | resolves `tsx`'s `bin` entry and spawns it with `process.execPath` |
| `tests/guardrails/prisma-major-pin.test.ts` | skip now keyed on Node failing to resolve, which is the real "not installed" condition |
| `jest.config.js` | `moduleNameMapper` target is now `require.resolve('react-grid-layout/legacy')` |

## Decisions

- **Resolve the entry point, not `<pkg>/package.json`.** That subpath is itself
  gated by `exports`, and cmdk's map declares only `"."` — so
  `require.resolve('cmdk/package.json')` throws on a perfectly healthy install.
  (motion, prisma and tsx all export `./package.json`, which is why the same
  spelling is fine at those call sites; swagger-ui-dist has no map at all.)
  Measured, not assumed — the first draft of the fix used the `package.json`
  subpath uniformly and went red on cmdk.
- **Resolve the specifier the app imports.** `src/` writes `from 'cmdk'` and
  `from 'motion/react'`, so those are what the test resolves. That is a strictly
  stronger property than "a directory exists at a guessed path": it also catches
  an upgrade that keeps the files but narrows the `exports` map.
- **`paths: [REPO_ROOT]` is inert under jest** and is kept only for consistency
  with the precedent guard. jest-resolve ignores it and resolves from the calling
  module — which walks up and finds the parent checkout anyway. The
  swagger-ui guard's header records the experiment that disproved the
  "it starts at the repo root" reading; do not rely on `paths` to redirect it.
- **Spawn `node <cli.mjs>`, not `.bin/tsx`.** The shim is a symlink whose
  existence and exec bit are an install detail; the `bin` field is the package's
  own declaration. It is also exactly what the shim does — `cli.mjs` opens
  `#!/usr/bin/env node`.
- **The detector parses; it does not lex.** The first draft searched raw text,
  found a `path.join(ROOT, 'node_modules', …)` written inside a test fixture's
  template literal, and ran its paren scan over a copy where that region was
  blank — never finding the closing paren and running on into whatever followed.
  That produced 11 false positives, one reporting a package named
  `;\n const aliased =`. The answer was a hand-rolled masker for comments,
  strings, templates *and* regexes, deliberately not `codeOf()` (whose scanner
  is not regex-aware). It was the wrong answer: masking regexes correctly
  requires deciding whether a `/` opens one, that decision is a heuristic, and
  the heuristic was wrong for a regex in keyword-operand position — the same
  class of bug one level down. `ts.createSourceFile` decides it from the grammar
  position instead, and it costs nothing: `typescript` is already a
  devDependency and `tests/helpers/assertion-reach.ts` had set the precedent.
- **Reduction is per-expression, not per-literal.** The lexer version pulled
  every string literal out of the sliced argument text, which cannot tell a path
  piece from a piece of something else and cannot follow a `const`. The AST
  version reduces each ARGUMENT — literal, template, array element, `+`
  concatenation, both arms of a conditional, or an identifier bound to a
  string-literal `const` — and emits an opaque, inert segment for anything it
  cannot read. An argument comment can therefore no longer donate a path piece,
  because it is not an expression.
- **Different prefix rules for the two call families.** `join` / `resolve` must
  not match on an arbitrary receiver (`['a','b'].join('/')`,
  `Promise.resolve(x)`), so only a bare call or a `path.` receiver counts. The
  `fs` readers are almost always written `fs.readFileSync(...)`, so their
  receiver is optional but named. A single shared lookbehind got this wrong in
  both directions.
- **Lockfile keys, skip lists, Jest patterns and shell-script assertions are out
  of scope by construction**, not by exemption — none of them is path
  construction. `lock.packages['node_modules/next']`, `entry.name ===
  'node_modules'`, `coveragePathIgnorePatterns: ['/node_modules/']` and
  `toContain('node_modules/.bin/prisma')` are all left alone, which is why the
  file needs no allowlist.
- **String concatenation onto a root IS covered, and the spawners are in the
  call list.** The lexer version's header declared both out of scope. Measured,
  that was half right, and in the flattering direction: it saw nothing at all
  for `spawnSync('node_modules/…')` (`total: 0`), but it *did* flag
  `readFileSync(ROOT + '/node_modules/next/…')` — by accident, because it
  harvested every literal out of the argument text. The shape it really missed
  is the SPLIT one, `ROOT + '/node_' + 'modules/next'`, and so did the first
  AST version: reducing each operand into the same piece list let the caller
  put a `/` between `node_` and `modules`. `+` has no separator, so the
  touching pieces of the two operands are fused into one; reduction now covers
  the family rather than the lucky case, and separate ARGUMENTS are still not
  fused (`path.join(ROOT, 'node_', 'modules')` really is `ROOT/node_/modules`).
  On the spawner half, `spawnSync('node_modules/.bin/tsx', …)` is one keystroke
  from the real `framework-import-cli` instance, so `spawnSync` / `spawn` /
  `execFileSync` / `execFile` / `execSync` / `exec` are matched too, including
  a path sitting in the argv array rather than the command. The `fs` family
  covers the promise API as well as the sync one: the receivers list named
  `fsp` / `promises` while the names list was sync-only, which read as coverage
  it did not have — `fsp.readFile('node_modules/x')` scanned as `total: 0`.
- **What is still uncovered is written down, and each line of it was RUN, not
  assumed.** A path piece whose value is not in the file (imported, returned by
  a function, read from `process.env`) reduces to opaque — the call is still
  seen and counted, the value simply is not knowable. An identifier with two
  string-literal bindings and no `node_modules` among them is ambiguous and
  stays opaque. A literal handed to a call not in the list — `new
  Worker('node_modules/x/worker.js')` — is not seen at all, and because the
  callee is matched by NAME, neither is a listed function reached through an
  alias (`const j = path.join; j(ROOT, 'node_modules', …)` scans as `total:
  0`). And a dependency path in a shell script, Dockerfile, npm script or
  workflow YAML is outside a TypeScript/JavaScript population entirely.
- **The denominator is part of the result, and the first version's was
  decoration.** It floored the file count and the call count at a round `1000`
  against ~5,000 files and ~5,500 calls — tolerating an 80% collapse, and duly
  failing to notice the calls its own lexer was losing (run side by side on the
  same population, the parser sees 5,454 where the lexer saw 5,388 — a 66-call
  hole the old floors were 4,400 calls away from noticing). The floors are now
  measured (5,032 files / 5,598 calls / 3,738 reduced arguments on 2026-09-07)
  and seated ~3% under, which is slack for deleting a test file and nothing
  more. The first attempt at those figures was one file high on each axis,
  because the throwaway harness doing the measuring was itself untracked in
  `tests/` and `git ls-files --others` counts it: measure the committed tree,
  with the ruler removed. A third floor was added on REDUCED ARGUMENTS,
  because calls can be recognised while the reducer returns nothing and the
  old pair would not have moved. Files that do not parse are reported and asserted empty, since
  `createSourceFile` recovers from syntax errors rather than throwing — an
  unparsed file yields no calls, which looks exactly like a clean one.
- **A count cannot say WHICH directories are in scope, so membership is
  asserted by name.** `eslint-rules/` and `__mocks__/` were missing from the
  first prefix list while its file floor still passed with room to spare — both
  are loaded from the checkout (the local ESLint plugin by `eslint.config.mjs`,
  the manual mock by Jest's resolver), so a spelled `node_modules` path in
  either reproduces the exact bug in a directory nobody would look at. The scan
  now names `jest.config.js`, `eslint-rules/`, `__mocks__/` and `prisma/` and
  fails if the population stops reaching them. `public/` is the one
  first-party-looking directory left out, and the reason is written down: it
  holds a vendored, minified swagger-ui bundle that is not ours to fix.
- **The population is "code this repo loads from its own checkout".** That is
  the property that makes the bug reproducible, so it is the rule rather than a
  list of subtrees somebody happened to think of. Repo-ROOT files are in scope
  and that is not incidental — `jest.config.js` is a root file, and scoping to
  `tests/` + `src/` + `scripts/` alone would have left the instance that cost
  the most uncovered.
- **`jest.config.js` is fixed with `require.resolve`, not with a corrected
  literal.** The config is a CommonJS module Node loads, so `require.resolve`
  there is Node's resolver: it walks up the directory chain *and* honours the
  `exports` map — which is the very thing the mapping existed to work around,
  since Jest's CJS resolver does not. The old literal was also the more fragile
  spelling: `react-grid-layout/dist/legacy.js` is **not** an exported subpath
  (only `./legacy` is), so it survived on Jest bypassing the exports gate.
- **The `<rootDir>` rule is a separate detector**, deliberately not folded into
  a general "any literal mentioning `node_modules`" rule. `<rootDir>` appears in
  Jest configuration and nowhere else, which is what keeps it free of the
  lockfile keys and skip lists such a rule would drag in. A bare
  `'<rootDir>/node_modules/'` — a `coveragePathIgnorePatterns` entry — is a
  pattern rather than a package path and is correctly not flagged, because the
  rule requires a named child.
