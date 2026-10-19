/**
 * THE HARNESS TAB ON /agents/reports (#3687), rendered.
 *
 * Four claims, each asserted where it is breakable — at the render:
 *
 *   1. EVERY CELL CARRIES ITS EVIDENCE REFERENCE, as what it is: an absolute
 *      http(s) URL is an external link with the noopener attrs; anything else
 *      (a vault reference, a path, `javascript:`) is copyable text and never a
 *      link; a cell with no pointer says so.
 *   2. ONLY "MET WITH EVIDENCE" RENDERS AS MET. Met-without-evidence, a blank
 *      pointer, a criterion reported twice whose second answer is worse, and a
 *      criterion never reported all render as not met — asserted on the
 *      `data-state` AND on the visible badge text.
 *   3. AN EMPTY POPULATION IS A FINDING. No scan at all, and a latest scan that
 *      found nobody, each render an alert — never the pack's "no agents" empty
 *      state, never an empty grid. An empty shadow list with no complete scan
 *      behind it is "unknown", not "none".
 *   4. THE ACCEPTANCE IS ON THE ROW. Its expiry is shown, and the rows that are
 *      short but not this viewer's to accept say why.
 *
 * Every absence is asserted beside something present from the same render, so
 * a component that rendered nothing cannot pass.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

// next-intl is ESM; resolve real en.json values. MEMOISED per namespace: the
// tables build columns in `useMemo([t])`, and a fresh `t` per render loops.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: mockRefresh, back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/reports',
    useSearchParams: () => new URLSearchParams('tab=harness'),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: ({ content }: { content: string }) => <span>{content}</span>,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// `ReportsClient` loads the harness tab through `next/dynamic`, which resolves a
// tick after the first render in jsdom. What is under test here is the tab, not
// the loading boundary, so the one dynamic import is answered synchronously.
jest.mock('next/dynamic', () => ({
    __esModule: true,
    default: () => require('@/app/t/[tenantSlug]/(app)/agents/reports/harness/HarnessTab').HarnessTab,
}));
import { ReportsClient } from '@/app/t/[tenantSlug]/(app)/agents/reports/ReportsClient';
import {
    ALL_HARNESS_CRITERIA,
    type CriterionVerdict,
    type HarnessCriterionId,
} from '@/lib/agentic/harness-ladder';
import type {
    HarnessMatrixView,
    HarnessScanRow,
    HarnessScannerKeysView,
    HarnessScannerSection,
    MatrixRow,
} from '@/lib/agentic/harness-read-model';

const EN = (
    jest.requireActual('../../messages/en.json') as {
        agents: {
            reports: Record<string, string>;
            harness: Record<string, string> & { cell: Record<string, string>; completeness: Record<string, string> };
        };
    }
).agents;
const H = EN.harness;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const scanRow = (over: Partial<HarnessScanRow> = {}): HarnessScanRow => ({
    id: 'scan_latest',
    scanRef: 'ref-latest',
    scannerAgentId: 'agt_scanner',
    scannerName: 'Estate scanner',
    scannerVersion: '1.2.0',
    asOf: '2026-10-15T03:00:00.000Z',
    ingestedAt: '2026-10-15T03:05:00.000Z',
    completeness: 'COMPLETE',
    agentCount: 1,
    sources: [
        { kind: 'entra-sp', status: 'COMPLETE', rows: 10, reason: null },
        { kind: 'mcp', status: 'COMPLETE', rows: 2, reason: null },
    ],
    ...over,
});

const matrixRow = (over: Partial<MatrixRow> = {}): MatrixRow => ({
    discoveredAgentId: 'da_1',
    discoveredId: 'entra:sp:one',
    discoveredVia: ['entra-sp'],
    registered: { agentId: 'agt_1', name: 'Reconciler' },
    level: 'H2',
    reach: 'WRITE_OR_EXTERNAL',
    belowBar: true,
    bar: 'H3',
    blockingNextRung: ['H3.manifests_pinned'],
    verdicts: [],
    verdictsUnreadable: false,
    models: { state: 'NOT_REPORTED' },
    latestIngestedLevel: null,
    acceptance: null,
    acceptAffordance: 'NONE',
    ...over,
});

const section = (over: Partial<HarnessScannerSection> = {}): HarnessScannerSection => {
    const latest = over.latest ?? scanRow();
    return {
        scannerAgentId: latest.scannerAgentId,
        scannerName: latest.scannerName,
        latest,
        previous: null,
        baseline: 'FIRST_SCAN',
        drift: null,
        driftUnavailableReason: 'FIRST_SCAN',
        rows: [matrixRow()],
        rowsUnread: false,
        rowsTruncated: false,
        ...over,
    };
};

const view = (over: Partial<HarnessMatrixView> = {}): HarnessMatrixView => {
    const sections = over.sections ?? [section()];
    return {
        generatedAt: '2026-10-17T09:00:00.000Z',
        scanWindow: 50,
        scans: { rows: sections.map((s) => s.latest), truncated: false },
        sections,
        scannersNotShown: 0,
        scannersWithoutScan: { rows: [], truncated: false },
        shadow: { rows: [], truncated: false, basis: 'EVIDENCED', basisAsOf: '2026-10-15T03:00:00.000Z' },
        acceptances: { rows: [], truncated: false },
        ...over,
    };
};

const NO_KEYS: HarnessScannerKeysView = {
    keys: { rows: [], truncated: false },
    candidates: { rows: [], truncated: false },
};

const renderHarness = (v: HarnessMatrixView, scannerKeys: HarnessScannerKeysView = NO_KEYS) =>
    render(
        <ReportsClient
            tab="harness"
            tenantSlug="acme"
            harness={v}
            scannerKeys={scannerKeys}
            // No estate declared (#3678): the estate card is its own suite's.
            estateHealth={{ generatedAt: '2026-10-19T00:00:00.000Z', scanWindow: 500, windowTruncated: false, estates: { rows: [], truncated: false } }}
            canReviewProposals
            canInvestigate
            canExport={false}
        />,
    );

const cell = (criterion: string, scanId = 'scan_latest', agent = 'da_1') =>
    screen.getByTestId(`harness-cell-${scanId}-${agent}-${criterion}`);

// ─── 1. The tabs ────────────────────────────────────────────────────────────

describe('the tabs', () => {
    it('the harness option is the current page, and no pack report renders under it', () => {
        renderHarness(view());
        const tabs = screen.getByTestId('reports-tabs');
        const harness = within(tabs).getByText(EN.reports.tabHarness).closest('a');
        const pack = within(tabs).getByText(EN.reports.tabPack).closest('a');
        expect(harness?.getAttribute('aria-current')).toBe('page');
        expect(harness?.getAttribute('href')).toBe('/t/acme/agents/reports?tab=harness');
        expect(pack?.getAttribute('aria-current')).toBeNull();
        expect(pack?.getAttribute('href')).toBe('/t/acme/agents/reports');
        // The harness body is here, the pack's is not.
        expect(screen.getByTestId('harness-report-only')).toBeInTheDocument();
        expect(screen.queryByTestId('reports-stamp')).not.toBeInTheDocument();
        expect(screen.queryByTestId('reports-asi-agents')).not.toBeInTheDocument();
    });
});

// ─── 2. Every cell carries its evidence reference ───────────────────────────

describe('every matrix cell renders its evidence reference, as what it is', () => {
    const POINTERS: Record<string, string | null> = {
        'H1.registered': 'https://graph.example.com/servicePrincipals/1',
        'H1.owner': 'kv://vault/agents/owner',
        'H1.axes_declared': '/etc/agents/axes',
        'H1.tier_scored_fresh': 'javascript:alert(1)',
        'H2.credential_bound': '/admin/agents',
        'H2.grant_kind_declared': null,
    };
    const verdicts: CriterionVerdict[] = ALL_HARNESS_CRITERIA.map((criterion) => ({
        criterion,
        met: true,
        evidence: criterion in POINTERS ? POINTERS[criterion] : `https://evidence.example/${criterion}`,
    }));

    beforeEach(() => {
        renderHarness(view({ sections: [section({ rows: [matrixRow({ verdicts })] })] }));
    });

    it('renders a cell for every criterion of the ladder', () => {
        for (const c of ALL_HARNESS_CRITERIA) expect(cell(c)).toBeInTheDocument();
    });

    it('an absolute https pointer is an external link with noopener; its text is the pointer', () => {
        const link = within(cell('H1.registered')).getByTestId('harness-evidence-link');
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('https://graph.example.com/servicePrincipals/1');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(link.textContent).toBe('https://graph.example.com/servicePrincipals/1');
    });

    it.each(['H1.owner', 'H1.axes_declared', 'H1.tier_scored_fresh', 'H2.credential_bound'])(
        '%s: a non-http(s) pointer is copyable text and NOT a link',
        (criterion) => {
            const c = cell(criterion);
            const text = within(c).getByTestId('harness-evidence-text');
            expect(text.textContent).toContain(POINTERS[criterion] as string);
            expect(c.querySelector('a')).toBeNull();
            expect(within(c).queryByTestId('harness-evidence-link')).not.toBeInTheDocument();
        },
    );

    it('a cell with no pointer says so', () => {
        const c = cell('H2.grant_kind_declared');
        expect(within(c).getByTestId('harness-evidence-none').textContent).toBe(H.cellNoEvidence);
        expect(c.querySelector('a')).toBeNull();
    });

    it('every cell renders exactly one of link / text / none, matching its pointer', () => {
        for (const v of verdicts) {
            const c = cell(v.criterion);
            const kinds = ['harness-evidence-link', 'harness-evidence-text', 'harness-evidence-none'].filter(
                (id) => within(c).queryByTestId(id) !== null,
            );
            expect(kinds).toHaveLength(1);
            if (v.evidence !== null) expect(c.textContent).toContain(v.evidence);
        }
    });
});

describe('a pointer that embedded credentials is redacted in the text, the copy value and the DOM', () => {
    // Built at runtime so no credential-shaped literal sits in this file.
    const password = ['S3cr', 'etPa', 'ss-', 'x'.repeat(8)].join('');
    const pointer = `https://svc-reader:${password}@vault.corp.example/v1/audit`;

    it('never prints, links or copies the password, and says why', () => {
        const verdicts: CriterionVerdict[] = ALL_HARNESS_CRITERIA.map((criterion) => ({
            criterion,
            met: true,
            evidence: criterion === 'H1.registered' ? pointer : `https://evidence.example/${criterion}`,
        }));
        const { container } = renderHarness(view({ sections: [section({ rows: [matrixRow({ verdicts })] })] }));

        const c = cell('H1.registered');
        // Positive anchor: the cell rendered the pointer, redacted.
        expect(within(c).getByTestId('harness-evidence-text').textContent).toContain('https://***@vault.corp.example/v1/audit');
        expect(within(c).getByTestId('harness-evidence-redacted').textContent).toBe(H.evidenceRedacted);
        expect(c.querySelector('a')).toBeNull();
        // Attributes included: the copy button's value must not carry it either.
        expect(container.innerHTML).not.toContain(password);
        expect(container.innerHTML).not.toContain('svc-reader:');
    });
});

// ─── 3. Only met-with-evidence renders as met ───────────────────────────────

describe('a criterion reported with no evidence renders as NOT met', () => {
    const verdicts: CriterionVerdict[] = [
        { criterion: 'H1.registered', met: true, evidence: 'https://evidence.example/registered' },
        { criterion: 'H1.owner', met: true, evidence: null },
        { criterion: 'H1.axes_declared', met: true, evidence: '   ' },
        { criterion: 'H1.tier_scored_fresh', met: true, evidence: 'https://evidence.example/tier' },
        // Reported twice; the SECOND answer is worse, and it is the one that counts.
        { criterion: 'H1.tier_scored_fresh', met: false, evidence: null },
        { criterion: 'H2.credential_bound', met: false, evidence: 'kv://vault/looked-here' },
        // H2.grant_kind_declared is never reported.
    ];

    beforeEach(() => {
        renderHarness(view({ sections: [section({ rows: [matrixRow({ verdicts })] })] }));
    });

    it('met WITH evidence is the only Met', () => {
        const c = cell('H1.registered');
        expect(c.getAttribute('data-state')).toBe('EVIDENCED');
        expect(c.textContent).toContain(H.cell.EVIDENCED);
    });

    it.each([
        ['H1.owner', 'MET_UNEVIDENCED'],
        ['H1.axes_declared', 'MET_UNEVIDENCED'],
        ['H1.tier_scored_fresh', 'NOT_MET'],
        ['H2.credential_bound', 'NOT_MET'],
        ['H2.grant_kind_declared', 'UNANSWERED'],
    ] as const)('%s renders %s, and its badge does not say Met', (criterion, state) => {
        const c = cell(criterion);
        expect(c.getAttribute('data-state')).toBe(state);
        const badge = c.querySelector('span');
        expect(badge?.textContent).toBe(H.cell[state]);
        expect(badge?.textContent).not.toBe(H.cell.EVIDENCED);
    });
});

describe('stored verdicts that could not be re-read', () => {
    it('render every cell unanswered, and the row says why', () => {
        renderHarness(
            view({ sections: [section({ rows: [matrixRow({ verdicts: [], verdictsUnreadable: true })] })] }),
        );
        expect(screen.getByTestId('harness-verdicts-unreadable-scan_latest-da_1').textContent).toBe(H.verdictsUnreadable);
        for (const c of ALL_HARNESS_CRITERIA as readonly HarnessCriterionId[]) {
            expect(cell(c).getAttribute('data-state')).toBe('UNANSWERED');
        }
    });
});

// ─── Model endpoints (#3759) ────────────────────────────────────────────────

describe('the model endpoints a scan reported for an agent (#3759)', () => {
    const HM = (H as unknown as { models: Record<string, string> }).models;
    const modelsCell = () => screen.getByTestId('harness-models-scan_latest-da_1');

    it('not reported and reported empty are two different things on the row', () => {
        const { unmount } = renderHarness(
            view({ sections: [section({ rows: [matrixRow({ models: { state: 'NOT_REPORTED' } })] })] }),
        );
        expect(modelsCell().getAttribute('data-state')).toBe('NOT_REPORTED');
        expect(modelsCell().textContent).toBe(HM.notReported);
        expect(modelsCell().textContent).not.toBe(HM.reportedEmpty);
        unmount();

        renderHarness(
            view({ sections: [section({ rows: [matrixRow({ models: { state: 'REPORTED', endpoints: [] } })] })] }),
        );
        expect(modelsCell().getAttribute('data-state')).toBe('REPORTED_EMPTY');
        expect(modelsCell().textContent).toBe(HM.reportedEmpty);
        expect(modelsCell().textContent).not.toBe(HM.notReported);
    });

    it('a stored value that could not be re-read says so, and reads as neither', () => {
        renderHarness(view({ sections: [section({ rows: [matrixRow({ models: { state: 'UNREADABLE' } })] })] }));
        expect(modelsCell().getAttribute('data-state')).toBe('UNREADABLE');
        expect(modelsCell().textContent).toBe(HM.unreadable);
    });

    it('lists each endpoint and its model as text, never as a link', () => {
        renderHarness(
            view({
                sections: [
                    section({
                        rows: [
                            matrixRow({
                                models: {
                                    state: 'REPORTED',
                                    endpoints: [
                                        { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                                        { endpoint: 'llm-gateway.internal.example', model: null },
                                    ],
                                },
                            }),
                        ],
                    }),
                ],
            }),
        );
        const c = modelsCell();
        expect(c.getAttribute('data-state')).toBe('REPORTED');
        const items = within(c).getAllByRole('listitem');
        expect(items.map((li) => li.textContent)).toEqual([
            'https://api.openai.com/v1gpt-4o-mini',
            `llm-gateway.internal.example${HM.modelAbsent}`,
        ]);
        expect(c.querySelector('a')).toBeNull();
    });
});

// ─── 4. An empty population is a finding ────────────────────────────────────

describe('an empty population renders as a finding, not as "no agents"', () => {
    it('no scan at all: an alert, no matrix, and not the pack\'s empty state', () => {
        renderHarness(view({ sections: [], scans: { rows: [], truncated: false } }));
        const finding = screen.getByTestId('harness-no-scans');
        expect(finding.getAttribute('role')).toBe('alert');
        expect(finding.textContent).toContain(H.noScansTitle);
        expect(finding.textContent).toContain(H.noScansBody);
        expect(screen.queryByText(EN.reports.emptyTitle)).not.toBeInTheDocument();
        expect(document.querySelector('[data-testid^="harness-matrix-"]')).toBeNull();
        expect(screen.queryByTestId('harness-shadow')).not.toBeInTheDocument();
        expect(screen.queryByTestId('reports-stamp')).not.toBeInTheDocument();
    });

    it('a latest scan that found nobody: an alert and NO matrix', () => {
        const empty = scanRow({ id: 'scan_empty', completeness: 'EMPTY', agentCount: 0 });
        renderHarness(view({ sections: [section({ latest: empty, rows: [] })] }));
        const finding = screen.getByTestId('harness-empty-scan-scan_empty');
        expect(finding.getAttribute('role')).toBe('alert');
        expect(finding.textContent).toContain(H.emptyScanTitle);
        expect(screen.getByTestId('harness-completeness-scan_empty').textContent).toBe(H.completeness.EMPTY);
        expect(screen.queryByTestId('harness-matrix-scan_empty')).not.toBeInTheDocument();
    });

    it('an empty shadow list with no complete scan behind it is UNSTATED, not none', () => {
        renderHarness(
            view({ shadow: { rows: [], truncated: false, basis: 'NOT_EVIDENCED', basisAsOf: null } }),
        );
        expect(screen.getByTestId('harness-shadow-unstated').textContent).toBe(H.shadowUnstated);
        expect(screen.queryByTestId('harness-shadow-none')).not.toBeInTheDocument();
        expect(screen.queryByTestId('harness-shadow-table')).not.toBeInTheDocument();
    });

    it('…and with a complete scan behind it, it is "none", as of that scan', () => {
        renderHarness(view());
        expect(screen.getByTestId('harness-shadow-none')).toBeInTheDocument();
        expect(screen.queryByTestId('harness-shadow-unstated')).not.toBeInTheDocument();
    });

    it('a non-empty shadow list renders its rows and reasons', () => {
        renderHarness(
            view({
                shadow: {
                    rows: [
                        {
                            discoveredAgentId: 'da_s',
                            discoveredId: 'entra:sp:shadow-1',
                            discoveredVia: ['entra-sp', 'vault'],
                            firstSeenAt: '2026-10-01T00:00:00.000Z',
                            lastSeenAt: '2026-10-15T00:00:00.000Z',
                            lastLevel: 'H0',
                            reason: 'REGISTER_ROW_DELETED',
                            findingId: 'fnd_s',
                            intake: null,
                        },
                    ],
                    truncated: false,
                    basis: 'EVIDENCED',
                    basisAsOf: '2026-10-15T03:00:00.000Z',
                },
            }),
        );
        const table = screen.getByTestId('harness-shadow-table');
        expect(table.textContent).toContain('entra:sp:shadow-1');
        expect(table.textContent).toContain((H as unknown as { shadowReason: Record<string, string> }).shadowReason.REGISTER_ROW_DELETED);
        expect(screen.queryByTestId('harness-shadow-none')).not.toBeInTheDocument();
    });
});

// ─── 5. The section, its completeness and its drift ─────────────────────────

describe('the scanner section states completeness and drift', () => {
    it('an incomplete scan names the sources it could not read, with the reason', () => {
        const latest = scanRow({
            completeness: 'INCOMPLETE',
            sources: [
                { kind: 'entra-sp', status: 'COMPLETE', rows: 10, reason: null },
                { kind: 'mcp', status: 'INCOMPLETE', rows: 1, reason: 'TIME_BOX' },
            ],
        });
        renderHarness(view({ sections: [section({ latest })] }));
        expect(screen.getByTestId('harness-completeness-scan_latest').textContent).toBe(H.completeness.INCOMPLETE);
        const notice = screen.getByTestId('harness-incomplete-scan-scan_latest');
        expect(notice.textContent).toContain('mcp');
        expect(notice.textContent).toContain('time box reached');
        expect(notice.textContent).not.toContain('entra-sp');
        // The matrix still renders: an incomplete scan is shown as what it is.
        expect(screen.getByTestId('harness-matrix-scan_latest')).toBeInTheDocument();
    });

    it('a complete scan has no incompleteness notice', () => {
        renderHarness(view());
        expect(screen.getByTestId('harness-completeness-scan_latest').textContent).toBe(H.completeness.COMPLETE);
        expect(screen.queryByTestId('harness-incomplete-scan-scan_latest')).not.toBeInTheDocument();
    });

    it('drift states every list, the empty ones as sentences', () => {
        const previous = scanRow({ id: 'scan_prev', scanRef: 'ref-prev', completeness: 'INCOMPLETE' });
        renderHarness(
            view({
                sections: [
                    section({
                        previous,
                        baseline: 'PREVIOUS_SCAN',
                        driftUnavailableReason: null,
                        drift: {
                            baselineScanId: 'scan_prev',
                            baselineScanRef: 'ref-prev',
                            baselineAsOf: previous.asOf,
                            baselineCompleteness: 'INCOMPLETE',
                            levelDrops: [{ discoveredAgentId: 'da_1', discoveredId: 'entra:sp:one', from: 'H3', to: 'H2' }],
                            newlySeen: [],
                            sourcesGoneIncomplete: [],
                            sourcesDropped: [],
                            sourceDriftUnknown: false,
                        },
                    }),
                ],
            }),
        );
        const drops = screen.getByTestId('harness-drift-scan_latest-drops');
        expect(drops.textContent).toContain('entra:sp:one: H3 → H2');
        expect(screen.queryByTestId('harness-drift-scan_latest-drops-none')).not.toBeInTheDocument();
        expect(screen.getByTestId('harness-drift-scan_latest-new-none').textContent).toBe(H.noNewlySeen);
        expect(screen.getByTestId('harness-drift-scan_latest-sources-none').textContent).toBe(H.noSourceDrift);
        // An incomplete baseline is stated, because it inflates "newly seen".
        expect(screen.getByTestId('harness-drift-scan_latest-baseline-incomplete').textContent).toBe(
            H.driftBaselineIncomplete,
        );
    });

    it('drift renders every newly seen agent and every source lost — gone incomplete and dropped — as lines', () => {
        const previous = scanRow({ id: 'scan_prev', scanRef: 'ref-prev' });
        renderHarness(
            view({
                sections: [
                    section({
                        previous,
                        baseline: 'PREVIOUS_SCAN',
                        driftUnavailableReason: null,
                        drift: {
                            baselineScanId: 'scan_prev',
                            baselineScanRef: 'ref-prev',
                            baselineAsOf: previous.asOf,
                            baselineCompleteness: 'COMPLETE',
                            levelDrops: [],
                            newlySeen: [{ discoveredAgentId: 'da_new', discoveredId: 'entra:sp:newcomer' }],
                            sourcesGoneIncomplete: [{ kind: 'mcp', reason: 'TIME_BOX' }],
                            sourcesDropped: ['vault'],
                            sourceDriftUnknown: false,
                        },
                    }),
                ],
            }),
        );
        const fresh = screen.getByTestId('harness-drift-scan_latest-new');
        expect(within(fresh).getByText('entra:sp:newcomer')).toBeInTheDocument();
        expect(fresh.textContent).toContain('Newly seen (1)');
        expect(screen.queryByTestId('harness-drift-scan_latest-new-none')).not.toBeInTheDocument();

        const sources = screen.getByTestId('harness-drift-scan_latest-sources');
        expect(sources.textContent).toContain('Source coverage lost (2)');
        expect(within(sources).getByText('mcp: read in full before, now incomplete (time box reached)')).toBeInTheDocument();
        expect(within(sources).getByText('vault: no longer reported')).toBeInTheDocument();
        expect(screen.queryByTestId('harness-drift-scan_latest-sources-none')).not.toBeInTheDocument();
        expect(screen.queryByTestId('harness-drift-scan_latest-sources-unknown')).not.toBeInTheDocument();
        // The empty list beside them is still a sentence.
        expect(screen.getByTestId('harness-drift-scan_latest-drops-none').textContent).toBe(H.noLevelDrops);
    });

    it('drift whose stored sources could not be re-read says source drift is UNKNOWN, not "none"', () => {
        const previous = scanRow({ id: 'scan_prev', scanRef: 'ref-prev', sources: null, completeness: 'INCOMPLETE' });
        renderHarness(
            view({
                sections: [
                    section({
                        previous,
                        baseline: 'PREVIOUS_SCAN',
                        driftUnavailableReason: null,
                        drift: {
                            baselineScanId: 'scan_prev',
                            baselineScanRef: 'ref-prev',
                            baselineAsOf: previous.asOf,
                            baselineCompleteness: 'INCOMPLETE',
                            levelDrops: [],
                            newlySeen: [],
                            sourcesGoneIncomplete: [],
                            sourcesDropped: [],
                            sourceDriftUnknown: true,
                        },
                    }),
                ],
            }),
        );
        expect(screen.getByTestId('harness-drift-scan_latest-sources-unknown').textContent).toBe(H.sourceDriftUnknown);
        expect(screen.queryByTestId('harness-drift-scan_latest-sources-none')).not.toBeInTheDocument();
        expect(screen.getByTestId('harness-drift-scan_latest-new-none').textContent).toBe(H.noNewlySeen);
    });

    it('a first scan says there is nothing to compare, rather than an empty drift', () => {
        renderHarness(view());
        expect(screen.getByTestId('harness-drift-scan_latest-unavailable').textContent).toBe(H.driftFirstScan);
        expect(screen.queryByTestId('harness-drift-scan_latest-drops')).not.toBeInTheDocument();
    });

    it('a row a later-received scan reads differently says so', () => {
        renderHarness(view({ sections: [section({ rows: [matrixRow({ latestIngestedLevel: 'H4' })] })] }));
        expect(screen.getByTestId('harness-latest-differs-scan_latest-da_1').textContent).toContain('H4');
    });
});

// ─── 6. Scan history ────────────────────────────────────────────────────────

describe('the scan history', () => {
    it('lists each scan\'s sources, and says when stored sources are unreadable', () => {
        const unreadable = scanRow({ id: 'scan_bad', scanRef: 'ref-bad', completeness: 'INCOMPLETE', sources: null });
        renderHarness(
            view({ scans: { rows: [scanRow(), unreadable], truncated: true } }),
        );
        const table = screen.getByTestId('harness-scans-table');
        expect(within(table).getByTestId('harness-scan-sources-scan_latest').textContent).toContain('entra-sp');
        expect(within(table).getByTestId('harness-scan-sources-unreadable-scan_bad').textContent).toBe(H.sourcesUnreadable);
        expect(within(table).getByTestId('harness-scan-completeness-scan_bad').textContent).toBe(H.completeness.INCOMPLETE);
        expect(screen.getByTestId('harness-scans-truncated')).toBeInTheDocument();
    });
});

// ─── 7. The acceptance on the row ───────────────────────────────────────────

describe('the acceptance is on the row', () => {
    it('shows the expiry, and a note on short rows that are not this viewer\'s to accept', () => {
        renderHarness(
            view({
                sections: [
                    section({
                        latest: scanRow({ agentCount: 4 }),
                        rows: [
                            matrixRow({
                                discoveredAgentId: 'da_owned',
                                acceptAffordance: 'RENEW',
                                acceptance: {
                                    id: 'acc_1',
                                    expiresAt: '2026-12-31T23:59:59.999Z',
                                    acceptedLevel: 'H2',
                                    renewal: false,
                                },
                            }),
                            matrixRow({ discoveredAgentId: 'da_theirs', acceptAffordance: 'OWNER_ONLY' }),
                            matrixRow({ discoveredAgentId: 'da_shadow', registered: null, acceptAffordance: 'REGISTER_FIRST' }),
                            matrixRow({ discoveredAgentId: 'da_fine', belowBar: false, level: 'H3', acceptAffordance: 'NONE' }),
                        ],
                    }),
                ],
            }),
        );
        expect(screen.getByTestId('harness-acceptance-expiry-scan_latest-da_owned').textContent).toContain('Accepted until');
        expect(screen.getByTestId('harness-accept-note-scan_latest-da_theirs').textContent).toBe(H.ownerOnly);
        expect(screen.getByTestId('harness-accept-note-scan_latest-da_shadow').textContent).toBe(H.registerFirst);
        expect(screen.getByTestId('harness-shadow-badge-scan_latest-da_shadow')).toBeInTheDocument();
        // The owner's own row and the row with nothing to accept carry no note.
        expect(screen.queryByTestId('harness-accept-note-scan_latest-da_owned')).not.toBeInTheDocument();
        expect(screen.queryByTestId('harness-accept-note-scan_latest-da_fine')).not.toBeInTheDocument();
        expect(screen.queryByTestId('harness-acceptance-expiry-scan_latest-da_theirs')).not.toBeInTheDocument();
    });

    it('the accept action renders ONLY where the server offered it — the owner\'s ACCEPT and RENEW rows', () => {
        renderHarness(
            view({
                sections: [
                    section({
                        latest: scanRow({ agentCount: 5 }),
                        rows: [
                            matrixRow({ discoveredAgentId: 'da_mine', acceptAffordance: 'ACCEPT' }),
                            matrixRow({
                                discoveredAgentId: 'da_owned',
                                acceptAffordance: 'RENEW',
                                acceptance: {
                                    id: 'acc_1',
                                    expiresAt: '2026-12-31T23:59:59.999Z',
                                    acceptedLevel: 'H2',
                                    renewal: false,
                                },
                            }),
                            // Short of the bar like the two above — the action
                            // follows OWNERSHIP, which only the server knows.
                            matrixRow({ discoveredAgentId: 'da_theirs', acceptAffordance: 'OWNER_ONLY' }),
                            matrixRow({ discoveredAgentId: 'da_shadow', registered: null, acceptAffordance: 'REGISTER_FIRST' }),
                            matrixRow({ discoveredAgentId: 'da_fine', belowBar: false, level: 'H3', acceptAffordance: 'NONE' }),
                        ],
                    }),
                ],
            }),
        );
        expect(screen.getByTestId('harness-accept-scan_latest-da_mine').textContent).toBe(H.accept);
        expect(screen.getByTestId('harness-accept-scan_latest-da_owned').textContent).toBe(H.renew);
        for (const id of ['da_theirs', 'da_shadow', 'da_fine']) {
            expect(screen.queryByTestId(`harness-accept-scan_latest-${id}`)).not.toBeInTheDocument();
        }
        // Exactly the two offered actions, and nothing else that accepts.
        const matrix = screen.getByTestId('harness-matrix-scan_latest');
        expect(
            within(matrix)
                .queryAllByRole('button')
                .filter((b) => b.textContent === H.accept || b.textContent === H.renew),
        ).toHaveLength(2);
        // The renewing row keeps its expiry beside the action.
        expect(screen.getByTestId('harness-acceptance-expiry-scan_latest-da_owned').textContent).toContain('Accepted until');
    });

    it('the acceptances card offers renew to the owner only; another viewer gets the note', () => {
        const card = (discoveredAgentId: string, acceptAffordance: 'RENEW' | 'OWNER_ONLY') => ({
            id: `acc_${discoveredAgentId}`,
            discoveredAgentId,
            agentLabel: `Agent ${discoveredAgentId}`,
            acceptedLevel: 'H2' as const,
            expiresAt: '2026-12-31T12:00:00.000Z',
            inForce: true,
            acceptAffordance,
        });
        renderHarness(
            view({ acceptances: { rows: [card('da_owned', 'RENEW'), card('da_theirs', 'OWNER_ONLY')], truncated: false } }),
        );
        expect(screen.getByTestId('harness-acceptance-renew-da_owned').textContent).toBe(H.renew);
        expect(screen.queryByTestId('harness-acceptance-renew-da_theirs')).not.toBeInTheDocument();
        expect(screen.getByTestId('harness-acceptance-note-da_theirs').textContent).toBe(H.ownerOnly);
    });

    it('the acceptances card renders each row under the anchor the calendar links to', () => {
        renderHarness(
            view({
                acceptances: {
                    rows: [
                        {
                            id: 'acc_1',
                            discoveredAgentId: 'da_owned',
                            agentLabel: 'Reconciler',
                            acceptedLevel: 'H2',
                            expiresAt: '2026-12-31T12:00:00.000Z',
                            inForce: true,
                            acceptAffordance: 'RENEW',
                        },
                    ],
                    truncated: false,
                },
            }),
        );
        const row = screen.getByTestId('harness-acceptance-row-da_owned');
        expect(row.id).toBe('harness-acceptance-da_owned');
        expect(row.textContent).toContain('Reconciler');
        expect(row.textContent).toContain(H.acceptanceInForce);
        expect(screen.getByTestId('harness-acceptance-row-expiry-da_owned').textContent).toContain('expires');
        expect(screen.queryByTestId('harness-acceptances-empty')).not.toBeInTheDocument();
    });
});

// ─── 8. Every bound is stated ───────────────────────────────────────────────

describe('nothing the server held back disappears silently', () => {
    it('a latest scan whose agents were not all read shows no matrix and says why — not "worst first"', () => {
        const latest = scanRow({ agentCount: 4000 });
        renderHarness(view({ sections: [section({ latest, rows: [], rowsUnread: true })] }));
        const notice = screen.getByTestId('harness-rows-unread-scan_latest');
        expect(notice.textContent).toContain('The 4000 agents of this scan could not all be read');
        expect(screen.queryByTestId('harness-matrix-scan_latest')).not.toBeInTheDocument();
        expect(screen.queryByTestId('harness-rows-truncated-scan_latest')).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain('worst first');
    });

    it('a capped matrix says how many of how many it shows', () => {
        renderHarness(view({ sections: [section({ latest: scanRow({ agentCount: 900 }), rowsTruncated: true })] }));
        expect(screen.getByTestId('harness-rows-truncated-scan_latest').textContent).toBe('Showing 1 of 900 agents, worst first.');
        expect(screen.getByTestId('harness-matrix-scan_latest')).toBeInTheDocument();
        expect(screen.queryByTestId('harness-rows-unread-scan_latest')).not.toBeInTheDocument();
    });

    it('hidden scanners are counted', () => {
        renderHarness(view({ scannersNotShown: 2 }));
        expect(screen.getByTestId('harness-scanners-not-shown').textContent).toContain('2 further scanner(s)');
    });

    it('a trusted scanner with no scan in the window is named, even with no scan at all', () => {
        renderHarness(
            view({
                sections: [],
                scans: { rows: [], truncated: false },
                scannersWithoutScan: {
                    rows: [
                        { agentId: 'agt_vault', name: 'Vault scanner' },
                        { agentId: 'agt_gone', name: null },
                    ],
                    truncated: true,
                },
            }),
        );
        const notice = screen.getByTestId('harness-scanners-without-scan');
        expect(notice.textContent).toContain('2 trusted scanner(s) hold a key but have no scan among the newest 50');
        expect(notice.textContent).toContain('Vault scanner, agt_gone');
        expect(screen.getByTestId('harness-scanners-without-scan-truncated').textContent).toBe(H.scannersWithoutScanTruncated);
        // Beside the no-scan finding, not instead of it.
        expect(screen.getByTestId('harness-no-scans')).toBeInTheDocument();
    });

    it('says nothing about silent scanners when there are none', () => {
        renderHarness(view());
        expect(screen.getByTestId('harness-shadow')).toBeInTheDocument();
        expect(screen.queryByTestId('harness-scanners-without-scan')).not.toBeInTheDocument();
        expect(screen.queryByTestId('harness-scanners-not-shown')).not.toBeInTheDocument();
    });

    it('a cut shadow list and a cut acceptances card each say so', () => {
        renderHarness(
            view({
                shadow: {
                    rows: [
                        {
                            discoveredAgentId: 'da_s',
                            discoveredId: 'entra:sp:shadow-1',
                            discoveredVia: ['entra-sp'],
                            firstSeenAt: '2026-10-01T00:00:00.000Z',
                            lastSeenAt: '2026-10-15T00:00:00.000Z',
                            lastLevel: 'H0',
                            reason: 'UNREGISTERED',
                            findingId: 'fnd_s',
                            intake: null,
                        },
                    ],
                    truncated: true,
                    basis: 'EVIDENCED',
                    basisAsOf: '2026-10-15T03:00:00.000Z',
                },
                acceptances: {
                    rows: [
                        {
                            id: 'acc_1',
                            discoveredAgentId: 'da_owned',
                            agentLabel: 'Reconciler',
                            acceptedLevel: 'H2',
                            expiresAt: '2026-12-31T12:00:00.000Z',
                            inForce: true,
                            acceptAffordance: 'RENEW',
                        },
                    ],
                    truncated: true,
                },
            }),
        );
        expect(screen.getByTestId('harness-shadow-truncated').textContent).toBe(
            'Only the 1 most recently seen shadow agents are listed.',
        );
        expect(screen.getByTestId('harness-acceptances-truncated').textContent).toBe('Only the first 1 acceptances are listed.');
    });
});
