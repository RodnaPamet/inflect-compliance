/**
 * Flat ESLint config — replaces `.eslintrc.json` after the Next 16
 * upgrade. Next 16's `eslint-config-next` ships flat config only,
 * which the legacy `.eslintrc.json` extends mechanism can't consume
 * (the deep-merge throws "Converting circular structure to JSON").
 *
 * Mirrors the rule layout from the previous `.eslintrc.json`:
 *   - default: warn on `any`, restrict deep table imports, allow
 *     described `@ts-ignore` / `@ts-expect-error`.
 *   - tests: relax `no-restricted-imports`.
 *   - `src/lib/security/**` + `src/middleware.ts`: error on `any`.
 *   - `src/app/**Client.tsx`: ban SkeletonTableRow / SkeletonDataTable
 *     imports + restrict deep table imports.
 */
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tsPlugin from '@typescript-eslint/eslint-plugin';
// This repo's own rules. CommonJS on purpose — see the header of
// ./eslint-rules/index.js for why `.mjs` and `.cjs` both fail here.
import localPlugin from './eslint-rules/index.js';
// The one definition of "the agentic path" — see that file's header. The guard
// at tests/guards/no-raw-prompt-logging.test.ts imports the same list, so the
// lint scope and the swept population cannot drift apart.
import { AGENTIC_PATH_GLOBS } from './eslint-rules/agentic-path.js';

// The platform-wide `no-restricted-syntax` bans. A const, because a later
// block that sets `no-restricted-syntax` for its own files REPLACES this list
// there rather than adding to it, so such a block spreads it back in.
const PLATFORM_SYNTAX_BANS = [
    {
        // Was tests/guards/no-inline-clipboard.test.ts (Epic 56).
        selector:
            "CallExpression[callee.object.object.name='navigator'][callee.object.property.name='clipboard'][callee.property.name=/^(writeText|write)$/]",
        message:
            'Copy through the shared primitives — useCopyToClipboard, <CopyButton> or <CopyText>. Bespoke clipboard calls lose SSR safety, the execCommand fallback, typed error reporting and the shared toast contract. See docs/tooltip-and-copy-strategy.md',
    },
    {
        // Was tests/guardrails/date-input-rollout.test.ts (Epic 58).
        selector:
            "JSXOpeningElement[name.name=/^[iI]nput$/]:has(JSXAttribute[name.name='type'][value.value=/^(date|datetime-local)$/])",
        message:
            'Use <DatePicker> (single date) or <DateRangePicker> (range) instead of a native date input — native pickers differ per browser and bypass the shared formatting. See docs/date-picker.md',
    },
];

// The harness scanner package's import boundary (#3678), shared by the
// package block and the stricter block for its `code` source (#3737), which
// would otherwise replace it.
const HARNESS_SCANNER_IMPORT_PATTERNS = [
    {
        regex: '^@/(?!lib/agentic/harness-(contract|findings|ladder)$|lib/canonical-json$)',
        message:
            'The harness scanner imports the wire contract (harness-contract, harness-findings, harness-ladder, canonical-json) and nothing else of the application. See packages/agent-harness-scanner/README.md.',
    },
    {
        group: ['@prisma/*', 'next', 'next/*', '@inflect/ui', '@inflect/ui/*'],
        message: 'The harness scanner runs in a client estate: no database client, no Next.js, no UI.',
    },
];

const config = [
    ...nextCoreWebVitals,
    {
        ignores: [
            '.next/**',
            // Local E2E (`scripts/e2e-local.mjs`) writes a Next build
            // to `.next-test/` (controlled by `distDir` when
            // `NEXT_TEST_MODE=1`). The chunks there are minified
            // bundler output that trip Next ESLint rules
            // (`@next/next/no-assign-module-variable` etc.) — they're
            // build artefacts, not source.
            '.next-test/**',
            'node_modules/**',
            // Claude Code runtime state. `.claude/worktrees/<id>/` holds
            // FULL checkouts of the repo, so `eslint .` would lint every
            // source file two or three times and report violations against
            // paths that are not the repo. Gitignored since the repo
            // adopted Claude Code (`.gitignore:136`); this list is the
            // hand-maintained twin that had not caught up.
            '.claude/**',
            'coverage/**',
            'playwright-report/**',
            // Static assets served verbatim — never source. Includes the
            // vendored, minified Swagger-UI bundle under public/swagger-ui/
            // (committed; see scripts/copy-swagger-ui.js). Linting minified
            // third-party JS is pointless and slow.
            'public/**',
        ],
    },
    {
        plugins: {
            // The Next preset only registers `@typescript-eslint` for
            // its TS-specific block, so our cross-cutting rules below
            // need the plugin re-registered in scope.
            '@typescript-eslint': tsPlugin,
            // ./eslint-rules — rules this repo owns. See its README for
            // when a rule belongs here rather than in `tests/guards/`.
            local: localPlugin,
        },
        rules: {
            // React 19's `eslint-plugin-react-hooks@6+` ships a set
            // of compiler-aware rules (`set-state-in-effect`, `refs`,
            // `immutability`, `error-boundaries`) that flag real but
            // non-breaking patterns across ~140 existing call sites.
            // Migrating each is a separate epic — downgrade to warn so
            // CI is unblocked and the violations stay visible.
            'react-hooks/set-state-in-effect': 'warn',
            'react-hooks/refs': 'warn',
            'react-hooks/immutability': 'warn',
            'react-hooks/rules-of-hooks': 'warn',
            'react-hooks/error-boundaries': 'warn',
            'react-hooks/purity': 'warn',
            'react-hooks/static-components': 'warn',
            'react-hooks/use-memo': 'warn',
            'react-hooks/set-state-in-render': 'warn',
            // `findDOMNode` is deprecated but the existing ~18 call
            // sites are inside library wrappers (vaul, react-grid-
            // layout) that haven't migrated yet. Surface as warn.
            'react/no-find-dom-node': 'warn',
            // ── This repo's own rules (./eslint-rules) ──
            //
            // Bans the teardown shape that emptied tables on the shared
            // test database in #2107 / #2113 / #2114: an unguarded
            // `deleteMany` in an `afterAll` whose filter reads a bare
            // `let` fixture id. Prisma DROPS an undefined filter value,
            // so the statement becomes an unpredicated DELETE — and it
            // SUCCEEDS, so the surrounding try/catch never fires and the
            // run stays green. Fourteen sites were fixed by hand across
            // two PRs with nothing stopping the sixteenth.
            //
            // Its first full-repo run found 12 live instances in five
            // files that both hand-sweeps missed; they are guarded in the
            // same diff, so `eslint .` is back to `0 errors, 245 warnings`
            // — the warning count on main. `error`, not `warn`: the remedy
            // is one `if (…)`, and a warning would not fail CI anyway
            // (`npm run lint` passes no --max-warnings).
            'local/no-fail-open-teardown-filter': 'error',
            // Externally-published URLs come from publicBaseUrl(), never the
            // request — behind a proxy `nextUrl.host` is the internal bind
            // address, which shipped as 0.0.0.0:3000 in production webhook URLs.
            'local/no-request-derived-public-url': 'error',
            // An AgentProposal / WorkflowRun row that names no agent cannot be
            // resolved back to the register, so "which agents run here?" gets
            // two answers and the register is the one on the compliance report.
            // Same for `policyCardVersion`: without it, "what was this agent
            // allowed to do when it did that?" has only today's answer, which
            // is the wrong one exactly when somebody has edited the card.
            // Both columns are nullable (each was added to populated tables,
            // and a human-started run genuinely has neither), so the type
            // system cannot ask for them — this does. It demands the fields be
            // NAMED, not non-null: `agentId: null` and `policyCardVersion:
            // NO_POLICY_CARD` are correct values, silence is not.
            'local/require-agent-attribution': 'error',

            // An MCP tool DECLARES the authorization its human equivalent
            // applies and never performs its own. The funnel is the one gate;
            // a tool that can check is a tool that can skip.
            // See eslint-rules/rules/require-mcp-tool-authorization.js.
            'local/require-mcp-tool-authorization': 'error',

            // A row click that opens the row navigates through
            // `useGuardedPush()`, never `router.push()`. Under hydration load
            // the client router gets its 200 and silently drops the transition
            // (#3099, upstream vercel/next.js#99651) — the row is dead until
            // the user clicks again, and nothing logs it. The hook re-issues the
            // push once and emits the only counter we have for how often that
            // happens in production. `DataTable` cannot be the choke point
            // (`onRowClick` is also how sheets and selection toggles are wired),
            // so the obligation has to live here.
            //
            // `allowRawPush` is the written exemption list and it is EMPTY: all
            // eighteen migrated call sites went through the hook. See the rule's
            // header for what to say when adding an entry.
            // The two census options stay off — they report facts, and only
            // tests/guards/row-click-navigation-uses-the-guarded-push.test.ts
            // turns them on.
            'local/no-router-push-in-row-click': ['error', { allowRawPush: [] }],
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/ban-ts-comment': [
                'warn',
                {
                    'ts-ignore': 'allow-with-description',
                    'ts-expect-error': 'allow-with-description',
                },
            ],
            'no-restricted-imports': [
                'warn',
                {
                    patterns: [
                        {
                            group: ['@/components/ui/table/*'],
                            message:
                                "Import from '@/components/ui/table' (barrel) instead of deep sub-modules.",
                        },
                    ],
                },
            ],
            // ── Platform bans, migrated from source-text guards ──
            //
            // These were `readFileSync` + regex tests under tests/guards.
            // As AST selectors they survive reformatting, renaming and
            // comment edits, which the regexes did not: the date-input
            // guard needed a whole `stripComments()` helper so a migration
            // note mentioning the old widget wouldn't fail the build. An
            // AST never sees a comment.
            //
            // Allowlists are `files:` override blocks further down rather
            // than in-rule arrays, so an exemption is scoped to the file it
            // is granted to instead of being matched by path string.
            'no-restricted-syntax': ['error', ...PLATFORM_SYNTAX_BANS],
        },
    },
    {
        // Legitimate clipboard call sites: the shared primitive itself, and
        // the canvas exporters, which write an image/png ClipboardItem —
        // `useCopyToClipboard` is text-only, and widening its contract for
        // every text caller to serve one image caller is the wrong trade.
        // Both engines' exporters are listed; the tldraw one has the same
        // justification and will outlive the xyflow one at the cutover.
        //
        // #3046 step 3a — `use-copy-to-clipboard.tsx` moved into the workspace
        // package, and this is §5.8 of docs/shared-ui-package-design.md happening:
        // "an override whose glob stops matching produces no error, it just stops
        // applying". Here it produced two, because the exemption stopped covering
        // the hook and the hook's own `navigator.clipboard` calls are exactly what
        // the rule forbids everywhere else. Both paths are listed rather than the
        // `src/` one being replaced, so the override survives a batch that moves
        // the file back, and so that the next reader can see where it lives now.
        files: [
            'src/components/ui/hooks/use-copy-to-clipboard.tsx',
            'packages/ui/src/components/ui/hooks/use-copy-to-clipboard.tsx',
            'src/lib/processes/canvas-export.ts',
            'src/lib/processes/tldraw-canvas-export.ts',
        ],
        rules: { 'no-restricted-syntax': 'off' },
    },
    {
        files: [
            'tests/**/*',
            '**/*.test.ts',
            '**/*.test.tsx',
            '**/*.spec.ts',
        ],
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-restricted-imports': 'off',
            // Scope parity with the guards these replaced: both scanned app
            // source only, never `tests/`. `eslint .` lints the whole repo,
            // so without this the migration would silently WIDEN
            // enforcement — e.g. tests/rendered/form-field.test.tsx renders
            // `<Input type="date" />` on purpose, to prove the FormField
            // primitive handles one. A migration should move a rule, not
            // quietly change what it covers.
            'no-restricted-syntax': 'off',
        },
    },
    {
        // ── The harness ladder is REPORT-ONLY (owner decision, 2026-10-17) ──
        //
        // A harness level (H0-H5) raises findings; it never gates activation or
        // a tool call. The cheapest way to break that is an import, so the
        // authority funnel may not import the ladder at all: a stale or failed
        // scan must never be able to stop a working agent. See #3660 and the
        // docblock in src/lib/agentic/harness-ladder.ts.
        files: [
            'src/lib/mcp/**/*',
            'src/lib/agentic/agent-authority.ts',
            'src/lib/agentic/agent-registration-gate.ts',
            'src/lib/agentic/agent-tool-exposure.ts',
            'src/lib/agentic/agent-credential-state.ts',
            'src/lib/agentic/autonomy-ceiling.ts',
            'src/lib/agentic/policy-card*.ts',
            'src/lib/agentic/kill-switch.ts',
            'src/lib/agentic/circuit-breaker*.ts',
            'src/app-layer/usecases/agent-registry.ts',
            'src/app-layer/usecases/workflow-runs.ts',
        ],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['@/lib/agentic/harness-ladder', '**/harness-ladder'],
                            message:
                                'The harness ladder is report-only: a level raises findings and never gates a call or an activation. Do not import it into the authority funnel.',
                        },
                    ],
                },
            ],
        },
    },
    {
        // ── The harness scanner package's boundary (#3678) ──
        //
        // `packages/agent-harness-scanner` runs in a CLIENT's estate, with that
        // estate's credentials. It shares the wire contract with the ingest —
        // it must, so the report it signs is checked by the schemas and signed
        // through the function the ingest verifies with — and nothing else of
        // the application: no database, no tenant, no Next.js, no usecase. A
        // scanner that could import `@/lib/prisma` is one refactor from a
        // scanner that writes somewhere it should only read.
        //
        // A regex rather than a `group` with negations: gitignore semantics
        // cannot re-include a file under an excluded parent, so `@/*` with
        // `!@/lib/agentic/harness-contract` would refuse the contract too.
        files: ['packages/agent-harness-scanner/src/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { patterns: HARNESS_SCANNER_IMPORT_PATTERNS }],
        },
    },
    {
        // ── The `code` source READS an estate's code and never runs it (#3737) ──
        //
        // The LangChain and LangGraph detector parses files it did not write,
        // from a repository a client controls. Loading one — a `require`, a
        // dynamic `import()`, an interpreter, `eval` — would hand that
        // repository code execution inside the scanner, beside its signing key.
        // So nothing in the source's files can reach any of them; the
        // side-effect test in tests/unit/agent-harness-scanner/
        // langchain-code-source.test.ts is the behavioural half.
        files: [
            'packages/agent-harness-scanner/src/sources/code/**/*.ts',
            'packages/agent-harness-scanner/src/sources/langchain.ts',
        ],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    paths: ['child_process', 'vm', 'worker_threads', 'module', 'cluster', 'inspector'].flatMap((name) =>
                        [name, `node:${name}`].map((n) => ({
                            name: n,
                            message: 'The code source reads code and never runs it: no subprocess, VM, worker or module loader.',
                        })),
                    ),
                    patterns: HARNESS_SCANNER_IMPORT_PATTERNS,
                },
            ],
            'no-restricted-syntax': [
                'error',
                ...PLATFORM_SYNTAX_BANS,
                { selector: 'ImportExpression', message: 'The code source never loads a module at run time.' },
                { selector: "CallExpression[callee.name='require']", message: 'The code source never loads a module at run time.' },
                { selector: "CallExpression[callee.name='eval']", message: 'The code source never evaluates text.' },
                { selector: "NewExpression[callee.name='Function'], CallExpression[callee.name='Function']", message: 'The code source never evaluates text.' },
            ],
        },
    },
    {
        files: ['src/lib/security/**/*', 'src/middleware.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    {
        files: ['src/app/**/*Client.tsx'],
        rules: {
            'no-restricted-imports': [
                'warn',
                {
                    paths: [
                        {
                            name: '@/components/ui/skeleton',
                            importNames: ['SkeletonTableRow', 'SkeletonDataTable'],
                            message:
                                "Use DataTable's `loading` prop instead of SkeletonTableRow. See src/components/ui/table/GUIDE.md",
                        },
                    ],
                    patterns: [
                        {
                            group: ['@/components/ui/table/*'],
                            message:
                                "Import from '@/components/ui/table' (barrel) instead of deep sub-modules.",
                        },
                    ],
                },
            ],
        },
    },
    {
        // ── The auditor agent's procedures re-perform from raw rows, and write
        //    no finding (#3676) ──
        //
        // `docs/agentic-audit-procedures.md`, Re-performance: a procedure never
        // takes a stored derived figure as evidence — a `CheckResult`, an
        // `IntegrationExecution.resultJson`, a card's `actionsInWindow`, a
        // window's breaker verdict, a control-test run, or the `executedAt`
        // stamp a campaign close writes on every decided row, skipped ones
        // included. And a workpaper never writes a Finding: every exception
        // leaves as a `propose_finding` proposal a person decides, so no
        // finding write, no finding usecase or repository, and no other propose
        // tool. The behavioural half is tests/integration/audit-procedures.test.ts,
        // where every failing fixture carries a stored figure that is wrong.
        //
        // These two rules REPLACE the base block's options for these files, and
        // its clipboard and date-input selectors cannot apply to server-side
        // procedure modules, which render nothing and run no browser API.
        files: ['src/app-layer/services/audit-procedures/**/*.ts'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['**/FindingRepository', '**/usecases/finding', '**/usecases/finding/**'],
                            message:
                                'An audit procedure writes no Finding: each exception is a propose_finding proposal a person decides.',
                        },
                    ],
                },
            ],
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        'MemberExpression[property.name=/^(resultJson|checkResult|actionsInWindow|anomalous|executedAt|controlTestRun)$/], Property[key.name=/^(resultJson|checkResult|actionsInWindow|anomalous|executedAt|controlTestRun)$/]',
                    message:
                        'An audit procedure re-performs from raw rows: it never reads a stored derived figure (a check result, an execution result, a card or breaker count, a control-test run, an executedAt stamp). See docs/agentic-audit-procedures.md, Re-performance.',
                },
                {
                    selector:
                        "CallExpression[callee.object.property.name='finding'][callee.property.name=/^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/]",
                    message: 'An audit procedure writes no Finding; it raises a propose_finding proposal.',
                },
                {
                    selector: "Literal[value=/^(propose_risks|propose_controls|draft_policy)$/]",
                    message: 'The auditor proposes findings and nothing else.',
                },
            ],
        },
    },
    {
        // ── The agentic path only ──
        //
        // `no-raw-prompt-logging` is the digest-only rule the AI-feature path
        // already keeps by convention (`src/app-layer/ai/decision-log` digests
        // its input and says so in a comment). A comment binds one module; this
        // binds a path — the one where the content arrives from an unvetted
        // external principal and the sink is a plaintext, hash-chained,
        // never-deleted audit row.
        //
        // Scoped rather than repo-wide because the vocabulary it polices
        // (`payload`, `context`, `input`, `args`) is ordinary English
        // elsewhere. A rule that fires on correct code teaches people to
        // disable it, and a disabled rule protects the path it was written for
        // least of all.
        //
        // The globs come from ./eslint-rules/agentic-path.js, which the
        // companion guard imports too. `reportUnanalysable` / `reportSinks`
        // stay OFF here — they are census output, not findings; the guard
        // turns them on to count what this rule could and could not judge.
        files: AGENTIC_PATH_GLOBS,
        rules: {
            'local/no-raw-prompt-logging': 'error',
        },
    },
    {
        // A focus indicator in the SHARED UI reads `--accent-default` /
        // `--accent-emphasis` (or the ring tokens), never a `--brand-*`
        // token. Inflect aliases the accent to its brand, so this changes no
        // pixel here; it is what lets a host that vendors this UI focus in a
        // different colour than it fills with (playerz.bg: yellow focus on
        // purple fills). Scoped to the shared directories because that is
        // where a host's copy comes from: app code under src/app and the
        // domain components is Inflect's alone, and Inflect's accent IS its
        // brand. See eslint-rules/rules/no-brand-focus-indicator.js.
        //
        // And it is drawn SOLID: an opacity modifier on a focus ring makes
        // its contrast depend on whatever it lands on. The table and card
        // rings were the accent at /40 and measured 1.7:1 to 2.8:1 against
        // WCAG 1.4.11's 3:1. See eslint-rules/rules/no-translucent-focus-indicator.js.
        files: [
            'src/components/ui/**/*.{ts,tsx}',
            'src/components/layout/**/*.{ts,tsx}',
            'packages/ui/src/**/*.{ts,tsx}',
        ],
        ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
        rules: {
            'local/no-brand-focus-indicator': 'error',
            'local/no-translucent-focus-indicator': 'error',
        },
    },
    {
        // `require-agent-attribution` is an invariant about PRODUCTION write
        // sites, and its companion guard already says so — the guard's
        // population is `repoFiles({ under: 'src' })`. The ESLint config did
        // not agree, so the rule also ran over `tests/`, where the one fixture
        // that MUST create an unattributed row lives: the legacy-backfill suite
        // seeds pre-migration `AgentProposal` / `WorkflowRun` rows precisely to
        // prove the backfill adopts them. Attributing those would delete the
        // thing under test.
        //
        // Scoped here rather than inside the rule so the two populations are
        // stated in one idiom each and can be compared: guard = under 'src',
        // lint = off outside it.
        files: ['tests/**/*.ts', 'tests/**/*.tsx'],
        rules: {
            'local/require-agent-attribution': 'off',
            // Same reasoning, same shape. `require-mcp-tool-authorization`'s
            // companion guard is `tests/guards/mcp-tools-use-shared-authz.test.ts`,
            // whose population is `repoFiles({ under: 'src' })` — it runs the
            // rule itself over exactly the files under `src/` that mention
            // `inputSchema`. Leaving the lint side repo-wide would make the two
            // populations disagree, and the disagreement is where the trouble
            // lives: a test that needs to BUILD a descriptor with no
            // `authorize` — to prove the funnel refuses one — would be
            // unwritable, which is the same trap the sibling rule above fell
            // into with the legacy-backfill fixture.
            'local/require-mcp-tool-authorization': 'off',
        },
    },
];

export default config;
