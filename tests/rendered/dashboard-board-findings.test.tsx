/**
 * The Board (executive dashboard) — the findings of #4458, rendered.
 *
 * Each block is one finding, asserted on what the reader sees or follows:
 *
 *   - the Task Status pie has an In Review slice, so it adds up;
 *   - the Risk Distribution slices open the OPEN risks they count;
 *   - the next-step button opens a list filtered the way the card says;
 *   - "Quick add" links open the create form and are offered only when the
 *     server would accept the create;
 *   - a failed Regenerate says why;
 *   - every KPI's click-to-scroll target exists;
 *   - the custom metric draws a trend only where daily history exists, the
 *     Audits metric opens the cycles list, and its slices are translated;
 *   - the labels render in the reader's language.
 *
 * The repo-wide `next-intl` manual mock reads English only and leaves ICU
 * plurals unexpanded, which would make both "in the reader's language" and
 * every counted sentence unassertable. This file's own mock carries the
 * catalogue its provider is given and expands `{n, plural, one {…} other {…}}`
 * the way next-intl does for these messages.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next-intl', () => {
    const R = require('react') as typeof React;
    const Messages = R.createContext<unknown>(require('../../messages/en.json'));
    const walk = (root: unknown, path: string): unknown =>
        path
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                root,
            );
    const format = (src: string, params?: Record<string, unknown>): string => {
        let out = src.replace(
            /\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}/g,
            (_m, name: string, one: string, other: string) => {
                const value = params?.[name];
                return (Number(value) === 1 ? one : other).split('#').join(String(value));
            },
        );
        for (const [name, value] of Object.entries(params ?? {})) {
            out = out.split(`{${name}}`).join(String(value));
        }
        return out;
    };
    return {
        NextIntlClientProvider: ({
            messages,
            children,
        }: {
            messages: unknown;
            children: React.ReactNode;
        }) => R.createElement(Messages.Provider, { value: messages }, children),
        useTranslations: (namespace?: string) => {
            const messages = R.useContext(Messages);
            return (key: string, params?: Record<string, unknown>) => {
                const found = walk(messages, namespace ? `${namespace}.${key}` : key);
                return typeof found === 'string' ? format(found, params) : key;
            };
        },
        useLocale: () => 'en',
        useNow: () => new Date(0),
        useTimeZone: () => 'UTC',
        useFormatter: () => ({
            dateTime: (d: unknown) => String(d),
            number: (n: unknown) => String(n),
            relativeTime: (d: unknown) => String(d),
            list: (l: Iterable<unknown>) => Array.from(l).join(', '),
        }),
    };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl:
        () => (path: string) =>
            `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    usePermissions: () => ({ controls: { edit: true } }),
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/onboarding/OnboardingBanner', () => {
    const Stub = () => null;
    Stub.displayName = 'OnboardingBannerStub';
    return Stub;
});

// jsdom does no layout; give the charts' auto-sizer a real box.
jest.mock('@visx/responsive', () => {
    const actual = jest.requireActual('@visx/responsive');
    return {
        ...actual,
        ParentSize: ({
            children,
        }: {
            children: (size: { width: number; height: number }) => React.ReactNode;
        }) => <>{children({ width: 300, height: 120 })}</>,
    };
});

import DashboardClient, {
    CHART_SCROLL_TARGETS,
} from '@/app/t/[tenantSlug]/(app)/dashboard/DashboardClient';
import { PostureHeroCard } from '@/app/t/[tenantSlug]/(app)/dashboard/PostureHeroCard';
import type { ExecutiveDashboardPayload } from '@/app-layer/repositories/DashboardRepository';
import type { TrendDataPoint, TrendPayload } from '@/app-layer/usecases/compliance-trends';
import type { DashboardKpiCardDto } from '@/app-layer/usecases/dashboard';
import type { PostureSummaryDto } from '@/app-layer/usecases/compliance-posture';
import en from '@/../messages/en.json';
import bg from '@/../messages/bg.json';

// ── fixtures ──────────────────────────────────────────────────────────

function buildExec(overrides: Partial<ExecutiveDashboardPayload> = {}): ExecutiveDashboardPayload {
    return {
        stats: {
            risks: 5,
            controls: 50,
            evidence: 100,
            openTasks: 7,
            openFindings: 2,
            highRisks: 1,
            pendingEvidence: 0,
            overdueEvidence: 0,
        },
        controlCoverage: {
            total: 50,
            applicable: 40,
            implemented: 30,
            inProgress: 5,
            notStarted: 5,
            planned: 0,
            needsReview: 0,
            coveragePercent: 75,
        },
        riskBySeverity: { low: 1, medium: 2, high: 1, critical: 1 },
        riskByStatus: { open: 3, mitigating: 1, accepted: 0, closed: 1 },
        evidenceExpiry: { overdue: 0, dueSoon7d: 0, dueSoon30d: 0, noReviewDate: 0, current: 100 },
        policySummary: {
            total: 5,
            draft: 1,
            inReview: 1,
            approved: 1,
            published: 2,
            archived: 0,
            overdueReview: 0,
        },
        taskSummary: {
            total: 11,
            open: 2,
            inProgress: 1,
            inReview: 3,
            blocked: 1,
            resolved: 4,
            overdue: 0,
        },
        vendorSummary: { total: 0, overdueReview: 0 },
        computedAt: new Date('2026-10-29T00:00:00Z').toISOString(),
        ...overrides,
    };
}

function point(date: string, assetsTotal: number): TrendDataPoint {
    // Only the fields the dashboard plots matter here; the rest are zero.
    return {
        date,
        controlCoveragePercent: 70,
        controlsTotal: 0,
        controlsImplemented: 0,
        controlsApplicable: 0,
        controlsInProgress: 0,
        controlsNotStarted: 0,
        risksTotal: 0,
        risksOpen: 3,
        risksCritical: 0,
        risksHigh: 0,
        risksAvgScore: null,
        risksOverdueReview: null,
        evidenceTotal: 0,
        evidenceOverdue: 1,
        evidenceDueSoon7d: 0,
        evidenceCurrent: 0,
        evidenceDraft: null,
        evidenceSubmitted: null,
        evidenceApproved: null,
        policiesTotal: 0,
        policiesOverdueReview: 0,
        policiesDraft: null,
        policiesInReview: null,
        policiesApproved: null,
        vendorsTotal: 0,
        vendorsOverdueReview: 0,
        vendorsActive: null,
        vendorsCritical: null,
        testPlansTotal: 0,
        testPlansActive: null,
        testPlansPaused: null,
        testPlansArchived: null,
        tasksTotal: 0,
        tasksOpen: 0,
        tasksOverdue: 0,
        tasksDueSoon7d: null,
        assetsTotal,
        assetsActive: 0,
        assetsHighCriticality: 0,
        assetsRetired: 0,
        findingsOpen: 2,
    };
}

const TRENDS: TrendPayload = {
    dataPoints: [point('2026-10-26', 8), point('2026-10-27', 9), point('2026-10-28', 10)],
    daysRequested: 30,
    daysAvailable: 3,
    rangeStart: '2026-09-29T00:00:00.000Z',
    rangeEnd: '2026-10-29T23:59:59.999Z',
};

const KPI: Record<string, DashboardKpiCardDto> = {
    assets: {
        key: 'assets',
        headline: 10,
        subtitle: { key: 'highCritical', count: 3 },
        segments: [
            { key: 'active', value: 6, color: '#22c55e' },
            { key: 'retired', value: 4, color: '#94a3b8' },
        ],
    },
    audits: {
        key: 'audits',
        headline: 7,
        subtitle: { key: 'complete', count: 4 },
        segments: [
            { key: 'planning', value: 2, color: '#94a3b8' },
            { key: 'inProgress', value: 1, color: '#f59e0b' },
            { key: 'ready', value: 0, color: '#3b82f6' },
            { key: 'complete', value: 4, color: '#22c55e' },
        ],
    },
};

const SUMMARY: PostureSummaryDto = {
    postureLabel: 'DEVELOPING',
    maturityScore: 46,
    summaryText: 'Half the applicable controls are implemented.',
    advice: [],
    provider: 'stub',
    model: null,
    generatedAt: '2026-10-29T00:00:00.000Z',
};

// ── fetch mock ────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown };
let regenerateReply: Reply = { status: 200, body: {} };
// What SWR's background revalidation of the executive payload returns —
// kept equal to the test's `initialExec`, so a revalidation that lands
// mid-test changes nothing the test is reading.
let execReply: ExecutiveDashboardPayload = buildExec();

const fetchMock = jest.fn(async (url: string) => {
    const reply = ((): Reply => {
        if (url.includes('/posture-summary/regenerate')) return regenerateReply;
        const kpi = /\/dashboard\/kpi\/(\w+)/.exec(url);
        if (kpi) return { status: 200, body: KPI[kpi[1]] };
        if (url.includes('/dashboard/trends')) return { status: 200, body: TRENDS };
        if (url.includes('/dashboard/posture-summary')) return { status: 200, body: SUMMARY };
        return { status: 200, body: execReply };
    })();
    return {
        ok: reply.status < 400,
        status: reply.status,
        url,
        headers: { get: () => null },
        json: async () => reply.body,
    };
});

beforeEach(() => {
    fetchMock.mockClear();
    regenerateReply = { status: 200, body: {} };
    execReply = buildExec();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
    window.localStorage.clear();
});

// ── harness ───────────────────────────────────────────────────────────

type Props = React.ComponentProps<typeof DashboardClient>;

function renderBoard(props: Partial<Props> = {}, locale: 'en' | 'bg' = 'en') {
    return render(
        <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : bg}>
            <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
                <TooltipProvider>
                    <DashboardClient
                        initialExec={buildExec()}
                        initialTrends={null}
                        {...props}
                    />
                </TooltipProvider>
            </SWRConfig>
        </NextIntlClientProvider>,
    );
}

/** The legend link for one slice, by its accessible name. */
function legendLink(container: HTMLElement, label: string, value: number) {
    return within(container).getByRole('link', {
        name: `${label}: ${value} — open filtered list`,
    });
}

// ── tests ─────────────────────────────────────────────────────────────

describe('Task Status pie', () => {
    it('has an In Review slice that opens the In Review tasks', () => {
        renderBoard();
        const card = document.getElementById('task-status')!;
        const link = legendLink(card, 'In Review', 3);
        expect(link).toHaveAttribute('href', '/t/acme/tasks?status=IN_REVIEW');
    });

    it('adds up to every task', () => {
        renderBoard();
        const card = document.getElementById('task-status')!;
        const values = within(card)
            .getAllByRole('link')
            .map((a) => Number(a.textContent?.match(/(\d+)$/)?.[1] ?? NaN));
        expect(values.reduce((n, v) => n + v, 0)).toBe(11);
    });
});

describe('Risk Distribution slices', () => {
    it('open the open risks in each band, as the band counts them', () => {
        renderBoard();
        const card = document.getElementById('risk-distribution')!;
        expect(legendLink(card, 'Critical', 1)).toHaveAttribute(
            'href',
            '/t/acme/risks?score=15|25&status=OPEN,MITIGATING,MITIGATED',
        );
    });
});

describe('next-step card', () => {
    it('opens the overdue tasks, not the whole list', () => {
        execReply = buildExec({
            taskSummary: { ...buildExec().taskSummary, overdue: 2 },
        });
        renderBoard({ initialExec: execReply });
        const card = document.querySelector('[data-next-best-action]') as HTMLElement;
        expect(card).toHaveAttribute('data-next-best-action-id', 'overdue-tasks');
        expect(within(card).getByText('2 tasks past due. Address them before the next audit.')).toBeInTheDocument();
        expect(screen.getByTestId('next-best-action-cta').closest('a')).toHaveAttribute(
            'href',
            '/t/acme/tasks?due=overdue',
        );
    });
});

describe('Quick add', () => {
    it('offers each create the viewer may make, opening its form', () => {
        renderBoard({ quickAdds: { risk: true, evidence: false, policy: true } });
        const row = document.querySelector('[data-next-best-action-quick-adds]') as HTMLElement;
        expect(within(row).getByRole('link', { name: 'Add Risk' })).toHaveAttribute(
            'href',
            '/t/acme/risks?create=1',
        );
        expect(within(row).getByRole('link', { name: 'New Policy' })).toHaveAttribute(
            'href',
            '/t/acme/policies?create=1',
        );
        expect(within(row).queryByRole('link', { name: 'Add Evidence' })).toBeNull();
    });

    it('offers nothing to a viewer who may create nothing', () => {
        renderBoard({ quickAdds: { risk: false, evidence: false, policy: false } });
        expect(document.querySelector('[data-next-best-action-quick-adds]')).toBeNull();
    });
});

describe('Recent Activity slot', () => {
    it('renders no placeholder when the page passes no card', () => {
        renderBoard();
        // The next-step card has the row to itself: no skeleton stands in
        // for a card this viewer will never get.
        const card = document.querySelector('[data-next-best-action]') as HTMLElement;
        expect(card.parentElement!.children).toHaveLength(1);
    });
});

describe('Regenerate', () => {
    it("shows the server's reason when it refuses", async () => {
        regenerateReply = {
            status: 403,
            body: { error: { code: 'FORBIDDEN', message: 'You may not regenerate the summary.' } },
        };
        renderBoard({ initialPostureSummary: SUMMARY });
        await act(async () => {
            fireEvent.click(screen.getByTestId('dashboard-hero-regenerate'));
        });
        expect(await screen.findByRole('alert')).toHaveTextContent(
            'You may not regenerate the summary.',
        );
    });

    it('says the summary was not replaced when the failure has no reason', async () => {
        regenerateReply = { status: 500, body: 'not json' };
        renderBoard({ initialPostureSummary: SUMMARY });
        await act(async () => {
            fireEvent.click(screen.getByTestId('dashboard-hero-regenerate'));
        });
        expect(await screen.findByTestId('dashboard-hero-regenerate-error')).toHaveTextContent(
            en.dashboard.hero.regenerateFailed,
        );
    });
});

describe('KPI click-to-scroll', () => {
    it('every KPI scrolls to a chart that is on the page', () => {
        renderBoard({ initialTrends: TRENDS });
        for (const [kpi, id] of Object.entries(CHART_SCROLL_TARGETS)) {
            expect([kpi, document.getElementById(id)]).not.toEqual([kpi, null]);
        }
    });
});

describe('custom metric', () => {
    it('draws the Assets trend from the daily snapshot', async () => {
        renderBoard({ initialTrends: TRENDS });
        const panel = await screen.findByTestId('custom-kpi-trend');
        expect(await within(panel).findByText('Assets 30-day trend')).toBeInTheDocument();
    });

    it('draws no trend panel for a metric with no daily history', async () => {
        window.localStorage.setItem('dashboard.customKpi', JSON.stringify('audits'));
        renderBoard({ initialTrends: TRENDS });
        const tile = await screen.findByRole('link', { name: 'Open Audits list' });
        // The Audits metric counts audit cycles, so it opens the cycles list.
        expect(tile).toHaveAttribute('href', '/t/acme/audits/cycles');
        await waitFor(() => expect(screen.getByText('4 complete')).toBeInTheDocument());
        expect(screen.queryByTestId('custom-kpi-trend')).toBeNull();
        expect(screen.queryByText(/still being collected/)).toBeNull();
    });

    it('labels its slices and subtitle in the reader’s language', async () => {
        window.localStorage.setItem('dashboard.customKpi', JSON.stringify('audits'));
        renderBoard({}, 'bg');
        await waitFor(() => expect(screen.getByText('4 завършени')).toBeInTheDocument());
        const pie = screen.getByTestId('custom-kpi-pie');
        expect(within(pie).getByText('Планиране')).toBeInTheDocument();
    });
});

describe('labels follow the reader’s language', () => {
    it('renders the Bulgarian catalogue, not English literals', () => {
        renderBoard(
            {
                initialTrends: TRENDS,
                quickAdds: { risk: true, evidence: true, policy: true },
            },
            'bg',
        );
        const tasks = document.getElementById('task-status')!;
        expect(within(tasks).getByText('В преглед')).toBeInTheDocument();
        const policies = document.getElementById('policy-status')!;
        expect(within(policies).getByText('Публикувани')).toBeInTheDocument();
        const risks = document.getElementById('risk-distribution')!;
        expect(within(risks).getByText('Критичен')).toBeInTheDocument();
        expect(screen.getByText('Бързо добавяне:')).toBeInTheDocument();
        expect(screen.getByText('3 дни данни')).toBeInTheDocument();
        expect(screen.getByText('30 от 40 внедрени')).toBeInTheDocument();
        expect(screen.getByText('30 от 40 контроли са внедрени')).toBeInTheDocument();
        for (const english of ['In Review', 'Quick add:', 'days of data', 'Critical']) {
            expect(screen.queryByText(english)).toBeNull();
        }
    });

    it('translates the one-word posture label', () => {
        render(
            <NextIntlClientProvider locale="bg" messages={bg}>
                <PostureHeroCard summary={{ ...SUMMARY, postureLabel: 'AT_RISK' }} />
            </NextIntlClientProvider>,
        );
        expect(screen.getByText('В риск')).toBeInTheDocument();
    });
});
