/**
 * `local/no-router-push-in-row-click` — RuleTester.
 *
 * The `valid` cases carry the weight. An invalid-only suite passes against a
 * rule that flags every `.push(` in the repository, so every narrowing the rule
 * performs gets a case that would go red if it broke:
 *
 *   · `guardedPush(...)` in the handler — the remedy must not be flagged, or
 *     people route around the rule;
 *   · `router.push` OUTSIDE a row handler (a filter change, a post-create
 *     redirect) — the defect is a cold row click, not every navigation;
 *   · `onRowClick` wired to something that is not a navigation at all
 *     (a sheet, a selection toggle) — these are why `DataTable` cannot be the
 *     choke point, and flagging them would be flagging the reason;
 *   · `onRowAuxClick`, deliberately out of scope — a middle click never enters
 *     the client router;
 *   · `queue.push(item)` and `history.replace` — `.push`/`.replace` on
 *     something that is not a router;
 *   · an `onRowClick` prop in a DESTRUCTURING pattern, which is how the table
 *     primitives receive it, and which must not be read as an assignment.
 *
 * The `invalid` cases cover the four shapes the eighteen migrated call sites
 * were written in — inline arrow, named handler resolved through scope,
 * `useCallback`, and nested inside a `&&` — plus the census modes, because a
 * census that silently reported nothing would make the companion guard's
 * denominator floor vacuous.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require('../rules/no-router-push-in-row-click');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});

/** Both census modes, for the cases that assert them. */
const CENSUS = [{ reportUnanalysable: true, reportRowClicks: true }];
/**
 * Holes only. A `valid` case cannot ask for `reportRowClicks` — every handler
 * reports under it, so "no messages" would be unreachable — but it CAN prove the
 * rule finds no hole where there is none.
 */
const HOLES = [{ reportUnanalysable: true }];

describe('local/no-router-push-in-row-click', () => {
    ruleTester.run('no-router-push-in-row-click', rule, {
        valid: [
            {
                name: 'the remedy: guardedPush in an inline handler',
                code: `
                    function C() {
                        const guardedPush = useGuardedPush();
                        return <DataTable onRowClick={(r) => guardedPush(href(r.id))} />;
                    }
                `,
            },
            {
                name: 'the remedy through a named useCallback handler',
                code: `
                    function C() {
                        const guardedPush = useGuardedPush();
                        const onRow = useCallback((r) => guardedPush(href(r.id)), [guardedPush]);
                        return <DataTable onRowClick={onRow} />;
                    }
                `,
            },
            {
                name: 'router.push outside any row handler — a filter change is not this defect',
                code: `
                    function C() {
                        const router = useRouter();
                        useEffect(() => { router.replace('/x?cycleId=1'); }, [router]);
                        return <DataTable onRowClick={(r) => setSelected(r)} />;
                    }
                `,
            },
            {
                name: 'router.push in a post-create callback, not a row click',
                code: `
                    function C() {
                        const router = useRouter();
                        return <Modal onCreated={(id) => router.push('/x/' + id)} />;
                    }
                `,
            },
            {
                name: 'onRowClick that opens a sheet — the reason DataTable cannot be the choke point',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowClick={(r) => setOpenId(r.original.id)} />;
                    }
                `,
            },
            {
                name: 'onRowAuxClick is out of scope — a middle click never enters the client router',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowAuxClick={(r) => router.push('/x/' + r.id)} />;
                    }
                `,
            },
            {
                name: '.push on something that is not a router',
                code: `
                    function C() {
                        const queue = [];
                        return <DataTable onRowClick={(r) => queue.push(r.original.id)} />;
                    }
                `,
            },
            {
                name: '.replace on something that is not a router',
                code: `
                    function C() {
                        const label = 'a-b';
                        return <DataTable onRowClick={() => label.replace('-', ' ')} />;
                    }
                `,
            },
            {
                name: 'an onRowClick in a DESTRUCTURING pattern is not an assignment',
                code: `
                    function Row({ onRowClick, row }) {
                        const router = useRouter();
                        const open = () => router.push('/x');
                        return <tr onClick={() => onRowClick(row)} />;
                    }
                `,
            },
            {
                name: 'the object-literal table bag, wired to the remedy',
                code: `
                    function C() {
                        const guardedPush = useGuardedPush();
                        const handleRow = useCallback((r) => guardedPush(href(r.id)), [guardedPush]);
                        return <EntityListPage table={{ data, columns, onRowClick: handleRow }} />;
                    }
                `,
            },
            {
                name: 'an exempted path may call the raw router',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowClick={(r) => router.push('/x')} />;
                    }
                `,
                filename: '/repo/src/app/legacy/LegacyClient.tsx',
                options: [{ allowRawPush: ['src/app/legacy/'] }],
            },
            {
                name: 'no hole reported where the handler IS resolvable',
                code: `
                    function C() {
                        const guardedPush = useGuardedPush();
                        const handleRow = (r) => guardedPush(href(r.id));
                        return <DataTable onRowClick={handleRow} />;
                    }
                `,
                options: HOLES,
            },
        ],

        invalid: [
            {
                name: 'inline arrow calling router.push',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowClick={(r) => router.push('/x/' + r.original.id)} />;
                    }
                `,
                errors: [{ messageId: 'rawRouterPush', data: { prop: 'onRowClick', method: 'push' } }],
            },
            {
                name: 'named handler resolved through scope — what a source regex cannot see',
                code: `
                    function C() {
                        const router = useRouter();
                        const handleAssetRowClick = (row) => router.push(href(row.original.id));
                        return <DataTable onRowClick={handleAssetRowClick} />;
                    }
                `,
                errors: [{ messageId: 'rawRouterPush' }],
            },
            {
                name: 'useCallback-wrapped handler in the object-literal table bag',
                code: `
                    function C() {
                        const router = useRouter();
                        const handleRow = useCallback((row) => router.push(href(row.original.id)), [router]);
                        return <EntityListPage table={{ data, onRowClick: handleRow }} />;
                    }
                `,
                errors: [{ messageId: 'rawRouterPush' }],
            },
            {
                name: 'guarded by && inside the handler, and nested in an inner callback',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowClick={(row) => {
                            requestAnimationFrame(() => {
                                row.original.control && router.push(href(row.original.control.id));
                            });
                        }} />;
                    }
                `,
                errors: [{ messageId: 'rawRouterPush' }],
            },
            {
                name: 'router.replace is a navigation too',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowClick={(r) => router.replace('/x/' + r.id)} />;
                    }
                `,
                errors: [{ messageId: 'rawRouterPush', data: { prop: 'onRowClick', method: 'replace' } }],
            },
            {
                name: 'onRowDoubleClick is policed as well — same activation, same defect',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowDoubleClick={(r) => router.push('/x/' + r.id)} />;
                    }
                `,
                errors: [{ messageId: 'rawRouterPush', data: { prop: 'onRowDoubleClick', method: 'push' } }],
            },
            {
                name: 'a router bound under another name, resolved through its useRouter() initialiser',
                code: `
                    function C() {
                        const nav = useRouter();
                        return <DataTable onRowClick={(r) => nav.push('/x/' + r.id)} />;
                    }
                `,
                errors: [{ messageId: 'rawRouterPush' }],
            },
            {
                name: 'exemption list does not match this file',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowClick={(r) => router.push('/x')} />;
                    }
                `,
                filename: '/repo/src/app/t/AssetsClient.tsx',
                options: [{ allowRawPush: ['src/app/legacy/'] }],
                errors: [{ messageId: 'rawRouterPush' }],
            },
            {
                name: 'census: an imported handler is counted as a hole, not silently passed',
                code: `
                    import { handleRow } from './handlers';
                    function C() {
                        return <DataTable onRowClick={handleRow} />;
                    }
                `,
                options: HOLES,
                errors: [
                    {
                        messageId: 'unanalysableHandler',
                        data: { prop: 'onRowClick', kind: 'identifier bound elsewhere' },
                    },
                ],
            },
            {
                name: 'census: a prop pass-through is a hole',
                code: `
                    function C(props) {
                        return <DataTable onRowClick={props.onRowClick} />;
                    }
                `,
                options: HOLES,
                errors: [
                    {
                        messageId: 'unanalysableHandler',
                        data: { prop: 'onRowClick', kind: 'not a function expression' },
                    },
                ],
            },
            {
                name: 'census: every recognised handler reports the denominator',
                code: `
                    function C() {
                        const guardedPush = useGuardedPush();
                        return <DataTable onRowClick={(r) => guardedPush('/x')} />;
                    }
                `,
                options: CENSUS,
                errors: [{ messageId: 'rowActivationSeen', data: { prop: 'onRowClick' } }],
            },
            {
                name: 'census: a violation and its denominator entry are both reported',
                code: `
                    function C() {
                        const router = useRouter();
                        return <DataTable onRowClick={(r) => router.push('/x')} />;
                    }
                `,
                options: CENSUS,
                errors: [{ messageId: 'rowActivationSeen' }, { messageId: 'rawRouterPush' }],
            },
        ],
    });
});
