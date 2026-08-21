/** @jest-environment jsdom */

/**
 * The dry-run leaver pass report — what an operator can tell apart on screen.
 *
 * VIEWPORT: 1280 × 800 (desktop). Stated because the report is a
 * master/detail pair of tables that is only laid out side-by-side-in-time on a
 * desktop admin surface; the mobile shell drops `<PageBreadcrumbs>` to its
 * inline branch and nothing below depends on that.
 *
 * The record exists so the seven-day observation window can be COMPARED against
 * what HR and IT actually did. Two readings destroy that comparison if the page
 * blurs them, and both are asserted here:
 *
 *   1. NOT_APPLICABLE is a pass that RAN AND REFUSED. Rendered as "not
 *      applicable" — or worse, as an absent row — it becomes indistinguishable
 *      from "no pass ran", which is the exact silence the record was built to
 *      break. So the three statuses must read as three different things, and the
 *      refusal must name itself.
 *
 *   2. `decisionsTruncated: true` means the decision list was cut at
 *      MAX_REPORTED_DECISIONS. A short list that does not say it is short is a
 *      report an operator would read as complete.
 *
 * Every negative assertion below is paired with a positive one in the SAME test,
 * because "the truncation banner is absent" also passes on a page that never
 * rendered.
 */
import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('next/navigation', () => ({
    usePathname: () => '/t/acme/admin/identity-leaver-passes',
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = ns.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en as unknown,
        );
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v;
        };
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// `useTenantSWR` resolves its key through `useTenantApiUrl`; the page's
// breadcrumb uses `useTenantHref`; the page's own gate reads `usePermissions`.
// Mocking the module covers all three so no TenantProvider tree is needed.
let mockOwner = true;
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    usePermissions: () => ({
        admin: { view: true, tenant_lifecycle: mockOwner },
    }),
}));

import { LeaverPassesClient } from '@/app/t/[tenantSlug]/(app)/admin/identity-leaver-passes/LeaverPassesClient';
import LeaverPassesPage from '@/app/t/[tenantSlug]/(app)/admin/identity-leaver-passes/page';
import en from '../../messages/en.json';

const M = (en as { admin: { leaverPasses: Record<string, string> } }).admin.leaverPasses;

// ── Fixture ────────────────────────────────────────────────────────────

/** Truncated: the pass ran, and its DECISION LIST was cut short. */
const PARTIAL_PASS = {
    id: 'pass-partial',
    provider: 'entra',
    status: 'PARTIAL',
    executedAt: '2026-08-20T02:00:00.000Z',
    completedAt: '2026-08-20T02:00:07.000Z',
    resultJson: {
        mode: 'DRY_RUN',
        evidence: 'snapshot',
        terminatedWorkers: 240,
        candidates: 210,
        population: 4100,
        batchRefused: null,
        counts: { DRY_RUN: 200 },
        decisions: [
            { linkId: 'lnk-entra-1', outcome: 'DRY_RUN' },
            { linkId: 'lnk-entra-2', outcome: 'DRY_RUN' },
        ],
        decisionsTruncated: true,
    },
};

/** Complete: the pass ran and reported every decision it made. */
const PASSED_PASS = {
    id: 'pass-passed',
    provider: 'okta',
    status: 'PASSED',
    executedAt: '2026-08-19T02:00:00.000Z',
    completedAt: '2026-08-19T02:00:03.000Z',
    resultJson: {
        mode: 'DRY_RUN',
        evidence: 'snapshot',
        terminatedWorkers: 3,
        candidates: 2,
        population: 880,
        batchRefused: null,
        counts: { DRY_RUN: 1, REFUSED_PROTECTED: 1 },
        decisions: [
            { linkId: 'lnk-okta-1', outcome: 'DRY_RUN' },
            {
                linkId: 'lnk-okta-2',
                outcome: 'REFUSED_PROTECTED',
                reason: 'The account this connection authenticates as.',
            },
        ],
        decisionsTruncated: false,
    },
};

/** Ran AND REFUSED — the row whose whole point is that it is not an absence. */
const REFUSED_PASS = {
    id: 'pass-refused',
    provider: 'google_workspace',
    status: 'NOT_APPLICABLE',
    executedAt: '2026-08-18T02:00:00.000Z',
    completedAt: '2026-08-18T02:00:01.000Z',
    resultJson: {
        mode: 'DRY_RUN',
        terminatedWorkers: 5,
        refusal: 'NO_FRESH_LINKS',
        detail:
            '5 terminated worker(s), but none has a directory link re-observed recently enough to act on.',
    },
};

const ALL_PASSES = [PARTIAL_PASS, PASSED_PASS, REFUSED_PASS];

// ── Harness ────────────────────────────────────────────────────────────

const fetchMock = jest.fn();

beforeEach(() => {
    // Stated viewport: desktop.
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 800 });
    mockOwner = true;
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

function arrange(passes: unknown[]) {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ passes }) });
}

async function renderReport() {
    const utils = render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
            <LeaverPassesClient />
        </SWRConfig>,
    );
    // The passes heading paints immediately; wait for the fetch to settle so the
    // table (or the empty line) is the resolved one.
    await screen.findByRole('heading', { name: M.passesHeading });
    return utils;
}

/**
 * Resolve a pass row's `<tr>`, re-querying until it is ATTACHED.
 *
 * The list paints its loading branch first and re-renders when SWR resolves, so
 * a node captured from a one-shot query can be detached by the time it is
 * clicked — `fireEvent` against an orphan dispatches into nothing and the
 * assertion fails for a reason unrelated to the behaviour under test.
 */
async function rowFor(provider: string): Promise<HTMLElement> {
    return waitFor(() => {
        const cell = screen.getByText(provider);
        const tr = cell.closest('tr');
        expect(tr).not.toBeNull();
        return tr as HTMLElement;
    });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('leaver pass report — the three statuses read as three different things', () => {
    it('labels PASSED, PARTIAL and NOT_APPLICABLE distinguishably, and never as the raw enum', async () => {
        arrange(ALL_PASSES);
        await renderReport();

        // Positive: all three labels are on screen, and they are three DIFFERENT
        // strings (a mapping collapsed to one label would still find "a" label).
        expect(await screen.findByText(M.statusPassed)).toBeInTheDocument();
        expect(screen.getByText(M.statusPartial)).toBeInTheDocument();
        expect(screen.getByText(M.statusRefused)).toBeInTheDocument();
        expect(new Set([M.statusPassed, M.statusPartial, M.statusRefused]).size).toBe(3);

        // Negative, paired with the positives above: the refused pass is NOT
        // rendered as the raw `NOT_APPLICABLE` token, which is the shape that
        // reads as "nothing here" to an operator scanning the window.
        expect(screen.queryByText('NOT_APPLICABLE')).toBeNull();
        expect(screen.queryByText('PARTIAL')).toBeNull();
    });

    it('names the refusal on the refused row and in its detail, rather than showing an empty pass', async () => {
        arrange(ALL_PASSES);
        await renderReport();

        // The list row carries the refusal code…
        expect(await screen.findByText('NO_FRESH_LINKS')).toBeInTheDocument();

        // …and selecting it surfaces the heading plus the pass's own sentence.
        await act(async () => {
            fireEvent.click(await rowFor('google_workspace'));
        });

        expect(await screen.findByText(M.refusalHeading)).toBeInTheDocument();
        expect(
            screen.getByText(/none has a directory link re-observed recently enough/),
        ).toBeInTheDocument();
        // A refusal genuinely has no per-account decisions — say so explicitly
        // rather than rendering an empty region.
        expect(screen.getByText(M.noDecisions)).toBeInTheDocument();
    });
});

describe('leaver pass report — a truncated report says it is truncated', () => {
    it('banners the cut on the selected pass and marks it in the list row', async () => {
        arrange(ALL_PASSES);
        await renderReport();

        // The most recent pass is selected by default, and it is the truncated one.
        const banner = M.truncated.replace('{shown}', '2');
        expect(await screen.findByText(banner)).toBeInTheDocument();
        // And the list row says so too, so seven days of passes can be scanned
        // without opening each one.
        expect(screen.getByText(M.truncatedShort)).toBeInTheDocument();
    });

    it('drops the banner for a complete report — and proves the swap happened', async () => {
        arrange(ALL_PASSES);
        await renderReport();

        const banner = M.truncated.replace('{shown}', '2');
        expect(await screen.findByText(banner)).toBeInTheDocument();

        await act(async () => {
            fireEvent.click(await rowFor('okta'));
        });

        // Positive: the complete pass IS the one now rendered — its decisions
        // are on screen. Without this the negative below would pass on a page
        // that had simply stopped rendering.
        expect(await screen.findByText('lnk-okta-2')).toBeInTheDocument();
        expect(screen.getByText('REFUSED_PROTECTED')).toBeInTheDocument();
        // Negative: no truncation claim is made about a report that is complete.
        expect(screen.queryByText(banner)).toBeNull();
    });
});

describe('leaver pass report — the page gate is OWNER-only', () => {
    function renderPage() {
        return render(
            <SWRConfig
                value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}
            >
                <LeaverPassesPage />
            </SWRConfig>,
        );
    }

    it('renders the report for a tenant OWNER', async () => {
        mockOwner = true;
        arrange(ALL_PASSES);
        renderPage();

        expect(await screen.findByRole('heading', { name: M.title })).toBeInTheDocument();
        expect(screen.queryByText(M.forbidden)).toBeNull();
    });

    it('refuses a non-OWNER admin as a REFUSAL, not as a failed load', async () => {
        mockOwner = false;
        arrange(ALL_PASSES);
        renderPage();

        // Positive: the refusal is stated, in the page's own words.
        expect(await screen.findByText(M.forbidden)).toBeInTheDocument();
        // Negatives, paired with it: the report is not rendered, and the user is
        // NOT shown the "couldn't load" line — which is what they would see if
        // the page rendered and the OWNER-gated endpoint 403'd underneath it.
        expect(screen.queryByRole('heading', { name: M.title })).toBeNull();
        expect(screen.queryByText(M.loadError)).toBeNull();
    });
});

describe('leaver pass report — nothing recorded yet', () => {
    it('says no pass has been recorded rather than rendering a blank card', async () => {
        arrange([]);
        await renderReport();

        expect(await screen.findByText(M.empty)).toBeInTheDocument();
        // Paired positive: the page itself rendered — the empty line is the
        // report's answer, not the absence of the report.
        expect(screen.getByRole('heading', { name: M.title })).toBeInTheDocument();
    });
});
