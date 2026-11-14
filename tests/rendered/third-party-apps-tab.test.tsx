/**
 * THE INTEGRATIONS TAB ON /agents/reports, rendered.
 *
 *   1. NO SCAN IS A FINDING. With no third-party application scan the tab
 *      renders an alert, never an empty table, and names a trusted scanner that
 *      has sent nothing.
 *   2. COVERAGE COMES FIRST, AND AN INCOMPLETE SOURCE SAYS SO. A source read in
 *      part is shown with its reason, and the scan carries the incomplete
 *      notice; an empty complete scan is an alert, not a clean bill.
 *   3. THE ROWS SAY WHAT WAS ESTABLISHED. A high grant with its class words and
 *      permission names; a member the product does not expose reads "not
 *      exposed", one the read did not establish "not known" — never "none";
 *      open findings beside the application.
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
    useSearchParams: () => new URLSearchParams('tab=integrations'),
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

// `ReportsClient` loads each tab through `next/dynamic`, which resolves a tick
// after the first render in jsdom. Under test here is the Integrations tab.
jest.mock('next/dynamic', () => ({
    __esModule: true,
    default: () => require('@/app/t/[tenantSlug]/(app)/agents/reports/integrations/IntegrationsTab').IntegrationsTab,
}));

import { ReportsClient } from '@/app/t/[tenantSlug]/(app)/agents/reports/ReportsClient';
import type {
    ThirdPartyAppInventoryView,
    ThirdPartyAppRow,
    ThirdPartyScanSection,
} from '@/lib/agentic/third-party-app-read-model';

const EN = (
    jest.requireActual('../../messages/en.json') as {
        agents: { reports: { integrations: Record<string, string> & { class: Record<string, string> } } };
    }
).agents.reports.integrations;

const row = (over: Partial<ThirdPartyAppRow> = {}): ThirdPartyAppRow => ({
    appId: 'app_entra',
    applicationId: 'entra:0d1e2c3b-0000-4000-8000-000000003686:sp:a0000006-0000-4000-8000-000000000001',
    sourceKind: 'entra-integrations',
    product: 'Microsoft Entra ID',
    name: 'Acme Mail Sync',
    privilege: 'HIGH',
    classes: ['MAIL', 'WRITE'],
    highPermissions: ['Mail.ReadWrite'],
    highPermissionCount: 1,
    unknownPermissionCount: 0,
    publisher: { state: 'READ', verified: false },
    owners: { state: 'READ', count: 0 },
    usage: 'UNUSED',
    signIn: 'READ',
    daysSinceSignIn: 231,
    openFindings: [
        { code: 'INTEGRATION_HIGH_PRIVILEGE_GRANT', findingId: 'f1', severity: 'HIGH' },
        { code: 'INTEGRATION_NO_OWNER', findingId: 'f2', severity: 'MEDIUM' },
    ],
    ...over,
});

const section = (over: Partial<ThirdPartyScanSection> = {}): ThirdPartyScanSection => ({
    scan: {
        id: 'scan_1',
        scanRef: 'acme-20261019',
        scannerAgentId: 'agt_scanner',
        scannerName: 'Estate scanner',
        scannerVersion: '0.15.0',
        asOf: '2026-10-19T03:00:00.000Z',
        ingestedAt: '2026-10-19T03:05:00.000Z',
        completeness: 'COMPLETE',
        applicationCount: 2,
        unusedDays: 90,
    },
    sources: [
        { kind: 'entra-integrations', product: 'Microsoft Entra ID', status: 'COMPLETE', reason: null, rows: 12, signIn: 'COMPLETE', signInReason: null, openFindings: [] },
        { kind: 'okta-integrations', product: 'Okta', status: 'COMPLETE', reason: null, rows: 4, signIn: 'NOT_READ', signInReason: null, openFindings: [] },
    ],
    rows: [
        row(),
        row({
            appId: 'app_okta',
            applicationId: 'okta:acme.okta.com:app:0oa1abcdEFGH23ijk456',
            sourceKind: 'okta-integrations',
            product: 'Okta',
            name: 'Acme Provisioning',
            classes: ['DIRECTORY'],
            highPermissions: ['okta.users.read'],
            publisher: { state: 'NOT_EXPOSED', verified: null },
            owners: { state: 'NOT_EXPOSED', count: null },
            usage: 'NOT_CONCLUDED',
            signIn: 'NOT_EXPOSED',
            daysSinceSignIn: null,
            openFindings: [],
        }),
    ],
    rowsTruncated: false,
    rowsUnread: false,
    ...over,
});

const view = (over: Partial<ThirdPartyAppInventoryView> = {}): ThirdPartyAppInventoryView => ({
    sections: [section()],
    scannersNotShown: 0,
    scannersWithoutScan: { rows: [], truncated: false },
    scanWindow: 50,
    scansTruncated: false,
    findingsTruncated: false,
    ...over,
});

function renderTab(v: ThirdPartyAppInventoryView) {
    return render(
        <ReportsClient
            tab="integrations"
            tenantSlug="acme"
            integrations={v}
            canReviewProposals
            canInvestigate
            canExport={false}
        />,
    );
}

describe('1. no scan is a finding', () => {
    it('renders the alert, names the silent scanner, and no table', () => {
        renderTab(
            view({ sections: [], scannersWithoutScan: { rows: [{ agentId: 'agt_scanner', name: 'Estate scanner' }], truncated: false } }),
        );
        expect(screen.getByTestId('integrations-no-scans')).toHaveTextContent(EN.noScansTitle);
        expect(screen.getByTestId('integrations-scanners-without-scan')).toHaveTextContent('Estate scanner');
        expect(screen.queryByTestId('integrations-section-scan_1')).toBeNull();
        expect(document.querySelector('[id^="integrations-apps-table-"]')).toBeNull();
        // The tab itself is offered.
        expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute('href', '/t/acme/agents/reports?tab=integrations');
    });
});

describe('2. coverage first, and incompleteness stated', () => {
    it('an incomplete source names its reason, and the scan says its rows are what was seen', () => {
        const s = section();
        renderTab(
            view({
                sections: [
                    section({
                        scan: { ...s.scan, completeness: 'INCOMPLETE' },
                        sources: [
                            { ...s.sources![0], status: 'INCOMPLETE', reason: 'RATE_LIMITED', signIn: 'INCOMPLETE', signInReason: 'AUTH_FAILED' },
                        ],
                    }),
                ],
            }),
        );
        const source = screen.getByTestId('integrations-source-entra-integrations');
        expect(source).toHaveTextContent('read in part');
        expect(source).toHaveTextContent('rate limited');
        expect(source).toHaveTextContent('authentication failed');
        expect(screen.getByTestId('integrations-incomplete-scan_1')).toHaveTextContent(EN.incompleteScan);
        expect(screen.queryByTestId('integrations-empty-scan_1')).toBeNull();
        // Coverage is rendered before the table.
        const coverage = screen.getByTestId('integrations-coverage-scan_1');
        const table = document.getElementById('integrations-apps-table-scan_1');
        expect(table).not.toBeNull();
        expect(coverage.compareDocumentPosition(table as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('an empty complete scan is an alert, with the source-level finding beside its source', () => {
        const s = section();
        renderTab(
            view({
                sections: [
                    section({
                        scan: { ...s.scan, completeness: 'EMPTY', applicationCount: 0 },
                        sources: [
                            {
                                ...s.sources![0],
                                openFindings: [{ code: 'INTEGRATION_EMPTY_INVENTORY', findingId: 'f9', severity: 'HIGH' }],
                            },
                        ],
                        rows: [],
                    }),
                ],
            }),
        );
        expect(screen.getByTestId('integrations-empty-scan_1')).toHaveTextContent(EN.emptyScan);
        expect(screen.getByTestId('integrations-source-finding-entra-integrations-INTEGRATION_EMPTY_INVENTORY')).toBeInTheDocument();
        expect(document.getElementById('integrations-apps-table-scan_1')).toBeNull();
    });
});

describe('3. the rows say what was established', () => {
    it('renders privilege, classes, not-exposed and not-known members, and open findings', () => {
        const s = section();
        renderTab(
            view({
                sections: [
                    section({
                        rows: [
                            ...s.rows,
                            row({
                                appId: 'app_unknown',
                                applicationId: 'entra:0d1e2c3b-0000-4000-8000-000000003686:sp:a0000006-0000-4000-8000-000000000002',
                                name: null,
                                privilege: 'NOT_CONCLUDED',
                                classes: [],
                                highPermissions: [],
                                highPermissionCount: 0,
                                unknownPermissionCount: 2,
                                publisher: { state: 'NOT_KNOWN', verified: null },
                                owners: { state: 'NOT_KNOWN', count: null },
                                usage: 'NOT_CONCLUDED',
                                signIn: 'NOT_KNOWN',
                                daysSinceSignIn: null,
                                openFindings: [],
                            }),
                        ],
                    }),
                ],
            }),
        );
        const table = document.getElementById('integrations-apps-table-scan_1') as HTMLElement;
        expect(table).not.toBeNull();

        const entra = screen.getByTestId('integrations-privilege-app_entra');
        expect(entra).toHaveTextContent('High privilege');
        expect(entra).toHaveTextContent(`${EN.class.MAIL}, ${EN.class.WRITE}`);
        expect(entra).toHaveTextContent('Mail.ReadWrite');
        expect(screen.getByTestId('integrations-publisher-app_entra')).toHaveTextContent(EN.publisherUnverified);
        expect(within(screen.getByTestId('integrations-findings-app_entra')).getByText('High-privilege grant')).toBeInTheDocument();

        for (const col of ['publisher', 'owners', 'sign-in']) {
            expect(screen.getByTestId(`integrations-${col}-app_okta`)).toHaveTextContent(EN.notExposed);
            expect(screen.getByTestId(`integrations-${col}-app_unknown`)).not.toHaveTextContent(EN.notExposed);
        }
        expect(screen.getByTestId('integrations-publisher-app_unknown')).toHaveTextContent(EN.notKnown);
        expect(screen.getByTestId('integrations-owners-app_unknown')).toHaveTextContent(EN.notKnown);
        expect(screen.getByTestId('integrations-sign-in-app_unknown')).toHaveTextContent(EN.notConcluded);
        expect(screen.getByTestId('integrations-privilege-app_unknown')).toHaveTextContent('Not concluded');
        expect(within(table).getByText(EN.unnamed)).toBeInTheDocument();
        // "None" is never what a not-known owner reads as.
        expect(screen.getByTestId('integrations-owners-app_unknown')).not.toHaveTextContent('No owner');
    });

    it('a truncated section and unread rows say so', () => {
        renderTab(view({ sections: [section({ rowsTruncated: true }), section({ scan: { ...section().scan, id: 'scan_2' }, rows: [], rowsUnread: true })] }));
        expect(screen.getByTestId('integrations-rows-truncated-scan_1')).toBeInTheDocument();
        expect(screen.getByTestId('integrations-rows-unread-scan_2')).toBeInTheDocument();
        expect(document.getElementById('integrations-apps-table-scan_2')).toBeNull();
    });
});
