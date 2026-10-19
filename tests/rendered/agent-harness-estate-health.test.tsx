/**
 * PER-ESTATE SCHEDULE HEALTH on the harness tab (#3678), rendered through
 * `ReportsClient` as the page renders it, from views the real
 * `computeEstateHealth` built.
 *
 *   1. A STALE ESTATE IS VISIBLE: its badge says Stale, and the text says which
 *      kind — a last complete scan that is too old, or none at all.
 *   2. PER SOURCE: each source's owner, its own freshness, and why the latest
 *      scan did not read it in full. A departed owner and a retired scanner are
 *      shown, not hidden.
 *   3. NO ESTATE DECLARED IS SAID IN WORDS, with or without scans — never an
 *      empty card.
 *
 * Every absence is asserted beside something present from the same render.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

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

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
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

jest.mock('next/dynamic', () => ({
    __esModule: true,
    default: () => require('@/app/t/[tenantSlug]/(app)/agents/reports/harness/HarnessTab').HarnessTab,
}));
import { ReportsClient } from '@/app/t/[tenantSlug]/(app)/agents/reports/ReportsClient';
import {
    computeEstateHealth,
    type EstateDeclaration,
    type EstateScanInput,
    type HarnessEstateHealthView,
} from '@/lib/agentic/harness-estate-health';
import type { HarnessMatrixView } from '@/lib/agentic/harness-read-model';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const owner = (userId: string, name: string | null, active = true) => ({ userId, name, active });

function scan(id: string, h: number, sources: EstateScanInput['sources'], agentCount = 4): EstateScanInput {
    return { id, scanRef: `ref-${id}`, asOf: hoursAgo(h), ingestedAt: hoursAgo(h), complete: !!sources?.every((s) => s.status === 'COMPLETE'), agentCount, sources };
}
const ok = (kind: string, rows = 5) => ({ kind, status: 'COMPLETE' as const, rows, reason: null });

const ACME: EstateDeclaration = {
    id: 'est_acme',
    name: 'Acme production',
    scannerAgentId: 'agt_a',
    scannerName: 'Acme scanner',
    scannerLive: true,
    cadenceHours: 24,
    sources: [
        { kind: 'okta-app', owner: owner('u_jane', 'Jane Identity') },
        { kind: 'vault', owner: owner('u_bob', 'Bob Secrets') },
    ],
};
const GLOBEX: EstateDeclaration = {
    id: 'est_globex',
    name: 'Globex identity',
    scannerAgentId: 'agt_g',
    scannerName: 'Globex scanner',
    scannerLive: true,
    cadenceHours: 12,
    sources: [{ kind: 'okta-app', owner: owner('u_jane', 'Jane Identity') }],
};
const INITECH: EstateDeclaration = {
    id: 'est_initech',
    name: 'Initech secrets',
    scannerAgentId: 'agt_i',
    scannerName: null,
    scannerLive: false,
    cadenceHours: 24,
    sources: [{ kind: 'vault', owner: owner('u_gone', 'Gone Owner', false) }],
};

function view(): HarnessEstateHealthView {
    return {
        generatedAt: NOW.toISOString(),
        scanWindow: 500,
        windowTruncated: false,
        estates: {
            truncated: false,
            rows: [
                computeEstateHealth(ACME, [scan('a1', 2, [ok('okta-app'), ok('vault'), ok('mcp')])], NOW),
                computeEstateHealth(GLOBEX, [scan('g1', 30, [ok('okta-app')])], NOW),
                computeEstateHealth(
                    INITECH,
                    [scan('i1', 3, [{ kind: 'vault', status: 'INCOMPLETE', rows: 0, reason: 'AUTH_FAILED' }], 0)],
                    NOW,
                ),
            ],
        },
    };
}

const NO_SCANS: HarnessMatrixView = {
    generatedAt: NOW.toISOString(),
    scanWindow: 50,
    scans: { rows: [], truncated: false },
    sections: [],
    scannersNotShown: 0,
    scannersWithoutScan: { rows: [], truncated: false },
    shadow: { rows: [], truncated: false, basis: 'NOT_EVIDENCED', basisAsOf: null },
    acceptances: { rows: [], truncated: false },
};

const renderTab = (estateHealth: HarnessEstateHealthView) =>
    render(
        <ReportsClient
            tab="harness"
            tenantSlug="acme"
            harness={NO_SCANS}
            scannerKeys={null}
            estateHealth={estateHealth}
            canReviewProposals
            canCompose={false}
            canInvestigate={false}
            canExport={false}
        />,
    );

describe('1. a stale estate is visible', () => {
    it('a fresh estate and a stale one side by side, each saying why', () => {
        renderTab(view());

        expect(screen.getByTestId('harness-estate-status-est_acme')).toHaveTextContent('Fresh');
        expect(screen.getByTestId('harness-estate-last-complete-est_acme')).toHaveTextContent('ref-a1');

        // Overdue: its last complete scan is shown, and so is its cadence and threshold.
        const globex = screen.getByTestId('harness-estate-est_globex');
        expect(within(globex).getByTestId('harness-estate-status-est_globex')).toHaveTextContent('Stale');
        expect(within(globex).getByTestId('harness-estate-last-complete-est_globex')).toHaveTextContent('Last complete scan:');
        expect(globex).toHaveTextContent('Every 12 h · stale after 18 h');

        // Never complete: said as such, not as a date.
        const initech = screen.getByTestId('harness-estate-est_initech');
        expect(within(initech).getByTestId('harness-estate-status-est_initech')).toHaveTextContent('Stale');
        expect(within(initech).getByTestId('harness-estate-last-complete-est_initech')).toHaveTextContent(
            'No complete scan among the newest 500 scans read.',
        );
        expect(screen.queryByTestId('harness-estates-none')).toBeNull();
    });
});

describe('2. per source: owner, freshness, and why not', () => {
    it('shows each source with its owner and its own status', () => {
        renderTab(view());
        const okta = screen.getByTestId('harness-estate-source-est_acme-okta-app');
        expect(okta).toHaveTextContent('Owner: Jane Identity');
        expect(okta).toHaveTextContent('Fresh');
        expect(screen.getByTestId('harness-estate-source-est_acme-vault')).toHaveTextContent('Owner: Bob Secrets');
        // A source read by the scanner and declared by nobody is called out.
        expect(screen.getByTestId('harness-estate-undeclared-est_acme')).toHaveTextContent('mcp');
    });

    it('an unreadable source says why, a departed owner is marked, and a retired scanner is called out', () => {
        renderTab(view());
        const vault = screen.getByTestId('harness-estate-source-est_initech-vault');
        expect(vault).toHaveTextContent('Stale');
        expect(vault).toHaveTextContent('Latest: incomplete: authentication failed');
        expect(vault).toHaveTextContent('Not read in full in any scan read');
        expect(screen.getByTestId('harness-estate-owner-departed-est_initech-vault')).toHaveTextContent('no longer an active member');
        expect(screen.getByTestId('harness-estate-scanner-retired-est_initech')).toBeInTheDocument();
        // The live scanner's estate carries neither marker.
        expect(screen.queryByTestId('harness-estate-scanner-retired-est_acme')).toBeNull();
        expect(screen.queryByTestId('harness-estate-owner-departed-est_acme-vault')).toBeNull();
    });
});

describe('3. no estate declared is said in words', () => {
    it('renders the gap beside the no-scans finding, never an empty card', () => {
        renderTab({ generatedAt: NOW.toISOString(), scanWindow: 500, windowTruncated: false, estates: { rows: [], truncated: false } });
        expect(screen.getByTestId('harness-estates')).toBeInTheDocument();
        expect(screen.getByTestId('harness-estates-none')).toHaveTextContent('No estate is declared');
        expect(screen.getByTestId('harness-no-scans')).toBeInTheDocument();
    });

    it('a narrowed scan window is stated', () => {
        renderTab({ ...view(), windowTruncated: true });
        expect(screen.getByTestId('harness-estates-window-truncated')).toHaveTextContent('Only the newest 500 scans were read');
    });
});
