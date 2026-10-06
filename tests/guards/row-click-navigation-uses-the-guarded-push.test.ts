/**
 * Every row click that opens a row goes through `useGuardedPush`.
 *
 * ── THE DEFECT (#3099, upstream vercel/next.js#99651) ────────────────────
 *
 * A cold row click inside the hydration window issues its RSC request, gets a
 * 200, loads the destination's page chunk — and the client router then silently
 * does nothing. The URL never changes (mechanical proof the React transition
 * never committed: `HistoryUpdater` is keyed on the router state), no request
 * starts more than 1000 ms after the click, and no `console.error` is written in
 * any of the three captures. The row is dead until the user clicks again, and
 * NOTHING ANYWHERE RECORDS IT — the defect's only visible trace in this repo's
 * whole history is an E2E flake.
 *
 * `src/lib/nav/use-guarded-push.ts` samples `location.pathname` at click time
 * and re-issues the push once if the pathname has not moved and the target
 * differs from it; it also beacons a counter, which is the measurement nobody
 * had.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ────────────────────────────────
 *
 * The ENFORCEMENT is `local/no-router-push-in-row-click`, an AST rule, because
 * the check is syntax and eleven of the eighteen migrated call sites pass their
 * handler BY NAME — a regex over source text cannot follow that, and would also
 * be satisfied by a doc comment mentioning `router.push`. The rule's own
 * narrowings are proved by `eslint-rules/__tests__/…`; that it is WIRED at
 * `error` is owned by `tests/guards/eslint-local-rules-wired.test.ts`.
 *
 * This file is the part ESLint cannot do from inside one file:
 *
 *   1. Run that rule over the population **git** defines, so a new list page
 *      fails here even for somebody who never runs `npm run lint`.
 *   2. Report the DENOMINATOR. "Zero violations" and "zero row handlers found"
 *      are the same output and only one of them means anything, so the handlers
 *      the rule recognised are counted and floored — and so is the swept file
 *      population above them.
 *   3. Cap what the rule CANNOT judge. It does no data-flow analysis, so a
 *      handler imported from another module or arriving as a prop is opaque. It
 *      reports each under its own messageId and the exact set is written down
 *      here.
 *   4. Prove the detector FIRES, and that it declines to fire on the remedy —
 *      a clean sweep by a rule that reports nothing is the same clean sweep.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Linter } from 'eslint';

import { repoRelativeFiles, repoRelative, REPO_ROOT } from '../helpers/repo-files';

// `require`, not `import`: under ts-jest's CommonJS output an ESM default
// import of a CJS parser yields the interop wrapper rather than the parser
// object, and a flat config silently falls back to espree — which cannot read a
// type annotation, so every `.tsx` file would "lint clean".
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('@typescript-eslint/parser');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../../eslint-rules/rules/no-router-push-in-row-click');

const RULE_ID = 'no-router-push-in-row-click';
const linter = new Linter();

interface Finding {
    file: string;
    line: number;
    messageId: string;
    message: string;
}

/**
 * Run the rule over one file's source in CENSUS mode.
 *
 * A PARSE FAILURE THROWS rather than returning zero findings — the silent-skip
 * shape this guard exists to refuse. A file that fails to parse has not been
 * checked, and "not checked" must never read as "clean".
 */
function lint(source: string, filename: string): Finding[] {
    const messages = linter.verify(
        source,
        [
            {
                files: ['**/*.tsx'],
                plugins: { local: { rules: { [RULE_ID]: rule } } },
                languageOptions: {
                    parser: tsParser,
                    ecmaVersion: 2022,
                    sourceType: 'module',
                    parserOptions: { ecmaFeatures: { jsx: true } },
                },
                rules: {
                    [`local/${RULE_ID}`]: [
                        'error',
                        { reportUnanalysable: true, reportRowClicks: true },
                    ],
                },
            },
        ],
        filename,
    );
    const fatal = messages.filter((m) => m.fatal);
    if (fatal.length > 0) {
        throw new Error(
            `${repoRelative(filename)} did not parse, so it was never checked: ${fatal
                .map((m) => `${m.line}: ${m.message}`)
                .join('; ')}`,
        );
    }
    return messages.map((m) => ({
        file: filename,
        line: m.line,
        messageId: String(m.messageId),
        message: m.message,
    }));
}

/**
 * The swept population: every `.tsx` file under `src/` that git lists. Row
 * handlers are JSX, so `.ts` cannot hold one — and narrowing the sweep to the
 * directories that hold list pages today would make the guard blind to the
 * nineteenth list page living somewhere new, which is the whole point.
 */
const SWEPT: readonly string[] = repoRelativeFiles().filter(
    (rel) => rel.startsWith('src/') && rel.endsWith('.tsx'),
);

const FINDINGS: readonly Finding[] = SWEPT.flatMap((rel) =>
    lint(readFileSync(path.join(REPO_ROOT, rel), 'utf8'), path.join(REPO_ROOT, rel)),
);

const byId = (id: string) => FINDINGS.filter((f) => f.messageId === id);

/**
 * FLOORS, not exact counts. A nineteenth list page RAISES both of these, and a
 * guard that reddened when somebody added a list page is one people route
 * around. What they exist to catch is the opposite direction: a sweep that
 * reads EMPTY — a renamed `src/`, a broken parser config, a rule whose
 * visitors stopped matching — because every "zero violations" assertion below
 * is satisfied by exactly that.
 *
 * MEASURED on the migration diff, not estimated — the first draft of this
 * comment guessed 456/32/25 and every figure was wrong: **1,018** `.tsx` files
 * swept, **37** row-activation handlers recognised across **27** files, of which
 * 18 navigate (through the hook) and the rest open a sheet, toggle a selection
 * or forward a prop.
 */
const SWEPT_FILE_FLOOR = 900;
const ROW_HANDLER_FLOOR = 33;

/**
 * Files that import the hook. A floor rather than a set, for the same reason —
 * and `onRowClick` is not the only legitimate caller a future page might have.
 *
 * 16 files hold the 18 migrated call sites (coverage and the tests page each
 * navigate from two tables).
 */
const HOOK_CALLER_FLOOR = 16;

/**
 * The positions the rule could not judge, as `<file> — <kind>`.
 *
 * NO LINE NUMBERS: a hole's line moves on every unrelated edit above it, and a
 * ratchet that reddens for that teaches people to update it without reading it.
 *
 * All four are inside the table PRIMITIVES, and all four are the same shape:
 * the component receives `onRowClick` as a prop and forwards it to the element
 * or sub-component that binds the DOM handler. The rule cannot open a prop, and
 * there is nothing to open — the handler is the CALLER's, and the caller is
 * swept separately. A prop forward is the one hole shape that is harmless
 * here.
 *
 * ADDING AN ENTRY is a decision, not a formality. A new entry naming a file
 * under `src/app/` is NOT harmless: that is a page whose row handler the rule
 * cannot see, so the "zero violations" assertion below says nothing about it.
 * Say in the same diff why the handler cannot be defined in the file that wires
 * it.
 */
const KNOWN_UNANALYSABLE: readonly string[] = [
    'src/components/ui/EvidenceGallery.tsx — identifier bound elsewhere',
    'src/components/ui/table/data-table.tsx — identifier bound elsewhere',
    'src/components/ui/table/table.tsx — identifier bound elsewhere',
    'src/components/ui/table/virtual-table-body.tsx — identifier bound elsewhere',
];

describe('the row-click population is swept, and the sweep is real', () => {
    it('git lists enough .tsx files for the clean results below to mean anything', () => {
        expect(SWEPT.length).toBeGreaterThanOrEqual(SWEPT_FILE_FLOOR);
    });

    it('the population holds the list pages this defect was measured on', () => {
        // #3099's own page first — a sweep that has lost it has lost the case.
        expect(SWEPT).toContain('src/app/t/[tenantSlug]/(app)/agents/AgentsClient.tsx');
        expect(SWEPT).toContain('src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx');
        expect(SWEPT).toContain('src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');
        expect(SWEPT).toContain('src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx');
        // …and the two shells row handlers reach the table through.
        expect(SWEPT).toContain('src/components/layout/EntityListPage.tsx');
        expect(SWEPT).toContain('src/components/ui/table/data-table.tsx');
    });

    it('the sweep recognised row-activation handlers — a clean result over zero says nothing', () => {
        expect(byId('rowActivationSeen').length).toBeGreaterThanOrEqual(ROW_HANDLER_FLOOR);
    });
});

describe('no row-activation handler calls the client router directly', () => {
    it('across every .tsx file under src/', () => {
        expect(
            byId('rawRouterPush').map((f) => `${repoRelative(f.file)}:${f.line}`),
        ).toEqual([]);
    });
});

describe('what the rule could NOT judge is counted, not hidden', () => {
    it('is exactly the set of file-and-kind pairs written down here', () => {
        const seen = [
            ...new Set(
                byId('unanalysableHandler').map((f) => {
                    // The kind is the parenthesised tail of the message.
                    const open = f.message.lastIndexOf('(');
                    const kind = f.message.slice(open + 1).replace(').', '');
                    return `${repoRelative(f.file)} — ${kind}`;
                }),
            ),
        ].sort();
        expect(seen).toEqual([...KNOWN_UNANALYSABLE].sort());
    });

    it('and no page under src/app/ is among them', () => {
        // The pages are where the defect lives. A hole there is a page the
        // "zero violations" assertion above cannot speak for.
        expect(KNOWN_UNANALYSABLE.filter((e) => e.startsWith('src/app/'))).toEqual([]);
    });
});

describe('the remedy is actually wired, not merely permitted', () => {
    const importers = SWEPT.filter((rel) =>
        readFileSync(path.join(REPO_ROOT, rel), 'utf8').includes(
            "from '@/lib/nav/use-guarded-push'",
        ),
    );

    it('enough list pages navigate through the hook', () => {
        // A rule banning `router.push` is satisfied by a page that stopped
        // navigating at all. This is the other half.
        expect(importers.length).toBeGreaterThanOrEqual(HOOK_CALLER_FLOOR);
    });

    it('including the page #3099 was measured on', () => {
        expect(importers).toContain(
            'src/app/t/[tenantSlug]/(app)/agents/AgentsClient.tsx',
        );
    });
});

describe('the detector fires — otherwise a clean sweep is a rule that reports nothing', () => {
    const asFile = (code: string) => lint(code, path.join(REPO_ROOT, 'src/probe.tsx'));

    it('a raw router.push in an inline row handler is caught', () => {
        const found = asFile(`
            function C() {
                const router = useRouter();
                return <DataTable onRowClick={(r) => router.push('/x/' + r.id)} />;
            }
        `).filter((f) => f.messageId === 'rawRouterPush');
        expect(found.length).toBe(1);
        expect(found[0].message).toContain('useGuardedPush()');
    });

    it('…and one reached through a NAMED handler, which is the shape a regex misses', () => {
        const found = asFile(`
            function C() {
                const router = useRouter();
                const handleRow = useCallback((r) => router.push('/x/' + r.id), [router]);
                return <EntityListPage table={{ data, onRowClick: handleRow }} />;
            }
        `).filter((f) => f.messageId === 'rawRouterPush');
        expect(found.length).toBe(1);
    });

    it('but the REMEDY is not caught — a rule that flags the fix is one people route around', () => {
        const found = asFile(`
            function C() {
                const guardedPush = useGuardedPush();
                const handleRow = useCallback((r) => guardedPush('/x/' + r.id), [guardedPush]);
                return <EntityListPage table={{ data, onRowClick: handleRow }} />;
            }
        `).filter((f) => f.messageId === 'rawRouterPush');
        expect(found).toEqual([]);
    });

    it('and neither is a row handler that opens a sheet instead of navigating', () => {
        // The reason `DataTable` cannot be the choke point. Flagging these
        // would be flagging the reason.
        const found = asFile(`
            function C() {
                const router = useRouter();
                return <DataTable onRowClick={(r) => setOpenId(r.original.id)} />;
            }
        `).filter((f) => f.messageId === 'rawRouterPush');
        expect(found).toEqual([]);
    });
});
