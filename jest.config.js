/**
 * Jest configuration — multi-project split.
 *
 *   `node` project: the existing 10,031-test suite (unit / integration /
 *     guards / ratchets) — runs under node, no DOM. Keeps the fast
 *     source-contract + backend tests isolated from the heavier jsdom
 *     boot.
 *
 *   `jsdom` project (Epic 55 hardening pass): real React render tests
 *     for the shared UI primitives. Scoped to `tests/rendered/**` so the
 *     existing suite continues to run under node with no behavioural
 *     change. Adds `@testing-library/react` + `@testing-library/jest-dom`
 *     + `jest-axe` for accessibility checks.
 *
 * Coverage settings live on the node project since the jsdom project
 * covers only the UI layer which has its own contract.
 */

// GAP-04 — post NextAuth v4 migration the ESM transform allowlist
// is much shorter. v4 ships as CJS so `next-auth` itself doesn't
// need transforming. The remaining entries (`jose`, `preact`,
// `preact-render-to-string`) are kept because they're transitive ESM
// deps of providers that v4 still pulls in (e.g. JWT signing via
// jose). `oauth4webapi` and `@auth/*` were v5-specific and can be
// dropped from the allowlist.
//
// `marked` is pure ESM since v6 (v18 ships only lib/marked.esm.js with
// `type: module` + no CJS entry), so `@/lib/policy/policy-content` —
// which imports it — must be transformed for the CJS node test project.
//
// The htmlparser2 cluster (2026-08 production bump). `sanitize-html`
// 2.17.6 raised its dep to `htmlparser2: ^12`, and npm installs that as
// a NESTED tree under node_modules/sanitize-html/node_modules/. Every
// member of it is `"type": "module"` with an `import`-first entry:
// htmlparser2@12, domhandler@6, domutils@4, dom-serializer@3,
// domelementtype@3, entities@8.
//
// BOTH the outer and inner package names are required, and it is worth
// knowing why. `transformIgnorePatterns` is an UNANCHORED regex tested
// against the whole path, so for
//   node_modules/sanitize-html/node_modules/htmlparser2/dist/index.js
// it first tries to match at the OUTER `node_modules/`. If the outer
// package is not allowlisted, the negative lookahead succeeds there, the
// pattern matches, and the file is ignored — no matter what the inner
// package is called. Naming only `htmlparser2` therefore fixes nothing;
// naming only `sanitize-html` fixes nothing either, because the engine
// then matches at the inner `node_modules/htmlparser2/`. Both must be
// listed so no position in the path matches.
// (`sanitize-html`'s own index.js is still CJS; it is here purely to
// stop the outer segment from matching.)
//
// Symptom without this: every suite transitively reaching
// `@/lib/security/sanitize` (the Epic C.5 sanitisation path — control-test,
// finding, policy usecases) dies with "Cannot use import statement outside
// a module", reported against sanitize-html/index.js:1 — the frame that
// required the ESM module, not the module at fault.
//
// TEST-HARNESS break only: `Build`, `Docker Build`, `Trivy` and `E2E` were
// all green on the same commit, i.e. Next handles the ESM entries fine at
// build and runtime.
const ESM_TRANSFORM_ALLOW_LIST =
    'jose|preact|preact-render-to-string|marked' +
    '|sanitize-html|htmlparser2|domhandler|domutils|dom-serializer|domelementtype|entities';

// ─── Coverage thresholds ─────────────────────────────────────────────
//
// Single source of truth for the coverage floors. Loaded here so the
// repo has ONE place where the numbers live; the CI gate reads the
// SAME file. Jest itself enforces none of it: a per-project
// `coverageThreshold` never reaches the globalConfig bucket the
// enforcement path reads, so the run exits 0 even when observed
// coverage is 9% against a 99% floor. See
// docs/implementation-notes/2026-04-27-gap-15-coverage-enforcement.md
// for the empirical proof (measured on jest 29.7.0; re-verified on the
// installed 30.4.2 — `globalConfig.coverageThreshold` is `undefined`).
//
// Enforcement is `scripts/check-merged-coverage.ts`, run once over the
// four merged shard artifacts by the `Coverage (≥60%)` CI job. The
// shards pass no threshold flag at all. Writing the values here gives
// `npm run test:coverage` the documented numbers in its summary; they
// do not fail that run.
const coverageThresholds = require('./jest.thresholds.json');

// ─── Coverage scope (shared across both projects) ────────────────────
//
// Three coverage keys, three different homes. Jest's `groupOptions`
// splits normalised options into a globalConfig bucket and a
// projectConfig bucket, and a key written to the wrong bucket is not an
// error — it is silently ignored. Verified against the installed jest
// (30.4.2) with `npx jest --showConfig`:
//
//   collectCoverageFrom        → global   (top-level `module.exports`)
//   coverageThreshold          → global   (but see below — it is set on
//                                          the node project on purpose,
//                                          where it does NOT enforce)
//   coveragePathIgnorePatterns → project  (both project blocks)
//
// `coverageThreshold` is the one deliberate exception. It sits on the
// node project as documentation, and `npx jest --showConfig` reports
// `globalConfig.coverageThreshold === undefined` as a result — so Jest
// enforces nothing and `scripts/check-merged-coverage.ts` is the gate.
// That is intentional: the CI shards each hold a quarter of the data,
// so a per-shard threshold would compare a quarter of the coverage
// against floors calibrated on all of it. The floors are checked once,
// on the merged total. `tests/guards/coverage-config-resolution.test.ts`
// pins all three placements.
//
// The scope itself is below, and the top-level `collectCoverageFrom` in
// `module.exports` carries the full story of why it lives there.
const sharedCollectCoverageFrom = [
    'src/app-layer/**/*.ts',
    'src/lib/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/types.ts',
];

/** @type {import('jest').Config} */
const nodeProject = {
    displayName: 'node',
    preset: 'ts-jest',
    testEnvironment: 'node',
    // NOTE: the default test timeout is set via `jest.setTimeout()` in
    // the setupFilesAfterEnv files below — Jest ignores a project-level
    // `testTimeout`, so it MUST go through a setup file (or root config).
    setupFiles: ['<rootDir>/jest.setup.js'],
    // - `jsdom-shims.ts` covers the handful of node-project tests that
    //   opt into jsdom via per-file `@jest-environment jsdom`
    //   directives. Safe to load in pure-node tests too (feature-
    //   detects `window`).
    // - `disconnect-after-suite.ts` registers a global `afterAll` that
    //   closes the `prismaTestClient()` singleton. Without it Jest
    //   workers exit via forceExit (see the "failed to exit
    //   gracefully" warning).
    setupFilesAfterEnv: [
        '<rootDir>/tests/setup/jsdom-shims.ts',
        '<rootDir>/tests/setup/disconnect-after-suite.ts',
    ],
    globalSetup: '<rootDir>/tests/setup/globalSetup.ts',
    globalTeardown: '<rootDir>/tests/setup/teardown.ts',
    moduleNameMapper: {
        '^@/env$': '<rootDir>/tests/mocks/env.ts',
        '^@/(.*)$': '<rootDir>/src/$1',
    },
    testMatch: ['**/*.test.ts', '**/*.test.js'],
    testPathIgnorePatterns: [
        '<rootDir>/.next/',
        '<rootDir>/node_modules/',
        '<rootDir>/tests/e2e/',
        '<rootDir>/tests/rendered/',
        '<rootDir>/dub-reference/',
        // ── Ratchets, when the caller opts out (JEST_SKIP_RATCHETS=1) ──
        //
        // `tests/guards/`, `tests/guardrails/` and `tests/contracts/` were
        // never excluded here, so `jest --shard=K/N` already ran all 777 of
        // them — and CI then ran `jest tests/guards/` and
        // `jest tests/contracts/` again as two more Jest boots, each
        // re-shelling `prisma migrate deploy`. 777 files, executed twice.
        //
        // They are now a separate CI job that needs no Postgres, because
        // exactly ONE of the 777 touches a database (`rls-coverage`, which
        // reads `pg_policies`); the rest are readFileSync + regex over
        // source text. That job runs them once, in parallel with the
        // shards, and the shards shed ~40% of their files.
        //
        // The env var (rather than a hard exclusion) keeps ONE config for
        // both jobs: the ratchet job runs the same config with the flag
        // unset and explicit paths.
        ...(process.env.JEST_SKIP_RATCHETS === '1'
            ? [
                  '<rootDir>/tests/guards/',
                  '<rootDir>/tests/contracts/',
                  // …except the one that needs the database, which stays
                  // with the DB-backed shards. Negative lookahead rather
                  // than moving the file: six other suites and CLAUDE.md
                  // reference it by path.
                  '<rootDir>/tests/guardrails/(?!rls-coverage\\.test\\.ts)',
              ]
            : []),
        // Epic 67 — co-located UI hook tests live next to the hook
        // (`src/components/ui/hooks/__tests__/`) but require jsdom
        // (RTL render, real React lifecycle). Excluded from the node
        // project so they run exclusively under the jsdom project's
        // testMatch.
        '<rootDir>/src/.*/__tests__/',
    ],
    transform: {
        '^.+\\.(ts|tsx)$': 'ts-jest',
        // Transpile the NextAuth ESM graph so middleware-importing
        // tests load without `SyntaxError: Cannot use import statement
        // outside a module`.
        '^.+\\.m?js$': 'ts-jest',
    },
    transformIgnorePatterns: ['node_modules/(?!(' + ESM_TRANSFORM_ALLOW_LIST + ')/)'],
    // Documentation only — Jest reads `collectCoverageFrom` from the
    // global config, never from a project. The load-bearing copy is at
    // the top level of `module.exports`.
    collectCoverageFrom: sharedCollectCoverageFrom,
    // A PROJECT option, unlike the two above. At the top level it is
    // dropped and the project falls back to `['/node_modules/']`.
    coveragePathIgnorePatterns: ['/node_modules/', '/.next/', '/tests/'],
    // ─── Coverage ratchet (GAP-15) ───────────────────────────────────
    //
    // POLICY: `docs/coverage-policy.md` is the risk-tiered coverage
    // policy — why each layer carries the bar it does (usecases/ and
    // policies/ are the highest-assurance tier), the end-state
    // targets, and the staged ratchet plan. The numbers below /
    // in `jest.thresholds.json` are the CURRENT FLOOR on that path.
    //
    // These thresholds DO enforce — they live on the node project, not
    // at the top-level config (where jest silently ignores them in
    // multi-project mode).
    //
    //  Why this is a ratchet, not a target.
    //  The thresholds below are the CURRENT FLOOR, not aspirational
    //  numbers. The single rule: when you add tests that raise the
    //  observed coverage, lift the floor in the same PR so the gain
    //  is locked in. Never lower a floor to "make CI green" — that
    //  is the failure mode the audit caught (GAP-02). Either add the
    //  test that restores the lost coverage, or revert the change
    //  that lost it.
    //
    //  How to raise.
    //  Run `npx jest --coverage --runInBand` locally (or wait for
    //  the CI coverage job to print the summary on your PR) and set
    //  each per-path floor to ~3% below the freshly observed number.
    //  The 3% buffer absorbs run-to-run jitter from parallel-worker
    //  scheduling and the occasional skipped suite. Pick the same
    //  buffer across metrics so the ratchet moves uniformly.
    //
    //  How to add a new gated path.
    //  Drop a new key (`'./src/<area>/'`) and run coverage to seed
    //  the floor. The path-prefix match is ~exact: trailing slash
    //  matters. Only add a path if the area has reached a coverage
    //  worth defending — otherwise the floor is noise.
    //
    //  Why the global is below 60.
    //  The audit's GAP-15 originally asked for 60/60 globally. The
    //  current numbers (br=50/fn=50/ln=62/st=59) say that target is
    //  not realistic with the current scope: `src/lib/**` includes
    //  one-shot scripts, instrumentation helpers, and CLI entry
    //  points shipped intentionally without unit tests. Tightening
    //  the global to match raw averages would penalise legitimate
    //  utility code; the durable lever is per-path tightening on
    //  areas that matter (e.g. `usecases/`) PLUS the structural
    //  enforcement fix above. When a future hardening pass either
    //  trims the scope (excludes scripts) or invests in src/lib/
    //  test coverage, raise the global toward 60.
    //
    //  What kinds of usecase tests count for the floor.
    //  The Wave 1-4 tests (`docs/implementation-notes/2026-04-25-
    //  gap-02-usecase-ratchet.md`) establish the contract:
    //    - assertCanRead/Write/Admin gates on every privileged path
    //    - sanitisation of every free-text field BEFORE persistence
    //      (Epic D.2 / C.5) — render-time only is not sufficient
    //    - cross-tenant id rejection (notFound on a cross-tenant
    //      lookup, not silent acceptance)
    //    - audit emission per state change (action + entityType)
    //    - notFound paths exercised
    //    - idempotency where applicable (e.g. archive/unarchive)
    //    - load-bearing transition ordering (e.g. promote-before-
    //      demote in tenant-ownership transfer)
    //  Each test should name the regression class it protects in a
    //  comment so the next reader can judge whether a refactor is
    //  weakening a guard.
    // Loaded from jest.thresholds.json (single source of truth shared
    // with CI). NOT enforced from here — a project-level
    // `coverageThreshold` never reaches the globalConfig bucket Jest
    // checks. `scripts/check-merged-coverage.ts`, run once over the
    // merged shard artifacts, is the authoritative enforcement point.
    coverageThreshold: coverageThresholds,
};

/** @type {import('jest').Config} */
const jsdomProject = {
    displayName: 'jsdom',
    preset: 'ts-jest',
    testEnvironment: 'jsdom',
    // Default test timeout set via `jest.setTimeout()` in
    // tests/rendered/setup.ts (project-level testTimeout is ignored).
    setupFiles: ['<rootDir>/jest.setup.js'],
    setupFilesAfterEnv: ['<rootDir>/tests/rendered/setup.ts'],
    moduleNameMapper: {
        '^@/env$': '<rootDir>/tests/mocks/env.ts',
        '^@/(.*)$': '<rootDir>/src/$1',
        // Epic 41 — react-grid-layout uses the package `exports` field
        // to map `react-grid-layout/legacy` → `dist/legacy.js`. Jest's
        // CJS resolver doesn't honour subpath exports under all
        // tsconfigs, so map the subpath to the resolved file directly.
        '^react-grid-layout/legacy$':
            '<rootDir>/node_modules/react-grid-layout/dist/legacy.js',
        '^react-grid-layout/css/styles\\.css$':
            '<rootDir>/tests/rendered/style-mock.ts',
        '^react-resizable/css/styles\\.css$':
            '<rootDir>/tests/rendered/style-mock.ts',
        // Pass-through stub for render tests that transitively touch the
        // Tooltip primitive through Button / Switch / StatusBadge (all of
        // which import it via `./tooltip`). Radix Tooltip requires a
        // TooltipProvider in the tree and emits portalised content — the
        // stub keeps those tests decoupled from that lifecycle. The
        // dedicated tooltip test at `tests/rendered/tooltip.test.tsx`
        // imports via `@/components/ui/tooltip` which is resolved by the
        // generic `@/` mapper above and bypasses this stub.
        '^\\.\\./tooltip$': '<rootDir>/tests/rendered/tooltip-mock.tsx',
        '^\\./tooltip$': '<rootDir>/tests/rendered/tooltip-mock.tsx',
        // Same problem with react-markdown directly.
        '^react-markdown$': '<rootDir>/tests/rendered/react-markdown-mock.tsx',
        // Vaul drawer crashes under React 19 (`transform.match(...)`
        // on undefined during pointer-up math). Render tests for
        // Modal etc. don't exercise drag gestures; a pass-through
        // stub keeps them decoupled. Re-evaluate when Vaul ships a
        // React 19 fix.
        '^vaul$': '<rootDir>/tests/rendered/vaul-mock.tsx',
        // CSS and static asset stubs for jsdom.
        '\\.(css|less|scss|sass)$': '<rootDir>/tests/rendered/style-mock.ts',
        // Epic 61 — `@number-flow/react` ships a custom-element + Web
        // Animations runtime that jsdom only partially supports. The
        // mock renders the same Intl.NumberFormat output the real
        // component settles on, so card render tests can assert on the
        // formatted text deterministically.
        '^@number-flow/react$': '<rootDir>/tests/rendered/number-flow-mock.tsx',
    },
    testMatch: [
        '<rootDir>/tests/rendered/**/*.test.{ts,tsx}',
        // Epic 67 — co-located UI hook tests pattern. Establishes the
        // future home for hook-level RTL tests so they live next to the
        // hook they verify rather than under tests/rendered/. The
        // existing `tests/rendered/` location stays valid for tests
        // that span multiple primitives or pages.
        '<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}',
    ],
    testPathIgnorePatterns: ['<rootDir>/.next/', '<rootDir>/node_modules/'],
    transform: {
        '^.+\\.(ts|tsx)$': [
            'ts-jest',
            { tsconfig: '<rootDir>/tests/rendered/tsconfig.json' },
        ],
        // Allow Jest to transpile transitively-imported ESM in
        // node_modules (react-markdown, @tiptap/*, etc.) so the shared
        // Tooltip / RichTextArea imports resolve under jsdom.
        '^.+\\.m?js$': [
            'ts-jest',
            { tsconfig: '<rootDir>/tests/rendered/tsconfig.json' },
        ],
    },
    transformIgnorePatterns: [
        // Explicitly allow ESM packages in the shared primitive graph
        // to be transformed. Everything else stays native-require.
        'node_modules/(?!(' +
            'react-markdown|' +
            'vfile|vfile-message|' +
            'unist-util-[^/]+|' +
            'mdast-util-[^/]+|' +
            'micromark[^/]*|' +
            'decode-named-character-reference|' +
            'character-entities[^/]*|' +
            'property-information|' +
            'hast-util-[^/]+|' +
            'space-separated-tokens|' +
            'comma-separated-tokens|' +
            'bail|is-plain-obj|trough|unified|' +
            'remark-[^/]+|rehype-[^/]+|' +
            '@tiptap/[^/]+|' +
            'prosemirror-[^/]+|' +
            'linkify-it|markdown-it|orderedmap|' +
            'w3c-keyname|' +
            // Epic 59 — chart platform. visx re-exports d3 modules
            // that ship as ESM; ts-jest must transform them so any
            // jsdom test importing `@/components/ui/charts` resolves
            // its full graph.
            '@visx/[^/]+|' +
            'd3-[^/]+|' +
            'internmap|delaunator|robust-predicates|' +
            // Epic 41 — react-grid-layout v2 ships ESM at the main
            // entry. Allow it through transform so the legacy
            // wrapper used by `<DashboardGrid>` resolves under jsdom.
            'react-grid-layout|react-resizable|react-draggable|' +
            // NextAuth v5 ships as ESM. The edge/node auth split
            // makes middleware.ts directly `import NextAuth from
            // "next-auth"`, so any unit/integration test that
            // imports middleware (cors.test.ts, auth-ratelimit.test.ts,
            // etc.) needs these transformed. Without this, the test
            // runner chokes with `SyntaxError: Cannot use import
            // statement outside a module` on next-auth/index.js.
            'next-auth|@auth/[^/]+|oauth4webapi|jose|preact|preact-render-to-string' +
            ')/)',
    ],
    // Documentation only, same as the node project's copy — the global
    // config is what Jest reads. Kept so this block states the scope
    // its incidental `src/app-layer/` + `src/lib/` hits land in.
    collectCoverageFrom: sharedCollectCoverageFrom,
    // A PROJECT option. Load-bearing here: without it the jsdom run
    // instruments `tests/setup/jsdom-shims.ts` and its siblings.
    coveragePathIgnorePatterns: ['/node_modules/', '/.next/', '/tests/'],
};

module.exports = {
    projects: [nodeProject, jsdomProject],
    // Recycle a worker once its heap crosses this after a suite. Over a
    // ~1400-suite run a long-lived worker accumulates module + mock state
    // until GC stalls (or it OOMs), which surfaces as NON-deterministic
    // "passes in isolation, fails in one parallel run" flakes on whatever
    // suite happened to be in-flight (observed: framework-tree-builder,
    // observability-metrics, mailer-init-wiring — all pure/structural, i.e.
    // not their own bug). Restarting the ballooned worker keeps heaps bounded
    // and the run reproducible. Belt-and-braces with the per-worker DB
    // isolation from the flake-fix (#951).
    workerIdleMemoryLimit: '512MB',
    // forceExit DELIBERATELY OFF — Jest exits naturally once the
    // disconnect-after-suite hook in tests/setup/disconnect-after-suite.ts
    // has closed the prisma + bullmq + audit-stream singletons. With
    // forceExit:true Jest emits the "A worker process has failed to
    // exit gracefully" warning even when there's no real leak (just
    // handles that close slightly past the default grace window).
    // Without it the run is ~30% slower but the warning goes away
    // and a real future leak will hang CI immediately, surfacing it
    // for diagnosis instead of getting masked.
    forceExit: false,
    // ─── The coverage scope, and the only place Jest reads it ────────
    //
    // `collectCoverageFrom` is a GLOBAL option. `groupOptions` in
    // jest-config routes it into `globalConfig`, and both consumers
    // that matter read it from there:
    //
    //   - jest-runner/build/index.js — feeds `shouldInstrument`, which
    //     filters WHAT gets instrumented. With an empty array there is
    //     no filter at all: every non-test module a suite loads is
    //     instrumented, including `src/components/**` and `src/app/**`.
    //   - @jest/reporters `_addUntestedFiles` — the ZERO-FILL, guarded
    //     by `if (globalConfig.collectCoverageFrom.length > 0)`. With
    //     an empty array nothing is zero-filled, so a file no test
    //     imports is absent from the report rather than counted at 0%.
    //
    // A copy on a project block is written and never read — nothing in
    // `@jest/*` or `jest-*` reads `projectConfig.collectCoverageFrom`.
    // The two project-level copies below are kept only so a reader of
    // either block can see the scope; this line is the load-bearing one.
    //
    // History: GAP-15 (#48) moved this key OUT of the top level while
    // fixing the threshold half of the same bug. From then until the
    // scope fix the gate's denominator was the suite's import graph
    // rather than a declared scope — the merged report held 1491 files
    // against 758 declared, ~730 of them React. Writing the first test
    // for a page enrolled that whole file at partial coverage and
    // pushed the global ratio DOWN; on 2026-08-11 that took `main` red
    // (docs/implementation-notes/2026-08-11-coverage-gate-enrolment.md).
    // `tests/guards/coverage-config-resolution.test.ts` now asserts the
    // resolved config, so a future relocation fails a test instead of
    // silently changing what the gate measures.
    collectCoverageFrom: sharedCollectCoverageFrom,
    // NOTE: `coverageThreshold` is INTENTIONALLY on the node project
    // below, not here — see the comment block on
    // `nodeProject.coverageThreshold` for the full GAP-15 history.
    // `coveragePathIgnorePatterns` is the mirror image: it is a PROJECT
    // option, so it lives on both project blocks. At the top level it
    // resolved to nothing and both projects fell back to the default
    // `['/node_modules/']`, which is how 17 `tests/**` and 8 `scripts/**`
    // files ended up inside the gated group.
    coverageReporters: ['text-summary', 'lcov'],
};
