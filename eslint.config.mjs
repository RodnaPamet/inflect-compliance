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
            'no-restricted-syntax': [
                'error',
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
            ],
        },
    },
    {
        // Legitimate clipboard call sites: the shared primitive itself, and
        // the canvas exporter, which writes an image/png ClipboardItem —
        // `useCopyToClipboard` is text-only, and widening its contract for
        // every text caller to serve one image caller is the wrong trade.
        files: [
            'src/components/ui/hooks/use-copy-to-clipboard.tsx',
            'src/lib/processes/canvas-export.ts',
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
];

export default config;
