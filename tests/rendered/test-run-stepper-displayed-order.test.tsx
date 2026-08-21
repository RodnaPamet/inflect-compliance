/**
 * #99 — the test-run stepper walks a plan's run history.
 *
 * Test runs are the sharpest instance of the `orderKey` + null-`listKey` axis
 * the #107 hook left open: they have no list ROUTE at all. The only surface in
 * the product that shows a plan's runs as a peer list is the "Run history"
 * block on `TestPlanDetailView`, so that view publishes and
 * `/tests/runs/{runId}` reads — with NO fallback, because there is no list
 * endpoint whose server order could stand in.
 *
 * The assertions below are on RENDERED behaviour, not on the presence of a
 * call: the arrows must appear, the down arrow must navigate to the run that
 * comes NEXT in the history as the DOM actually ordered it, and a run opened
 * without ever seeing a history must show no arrows at all.
 */
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SWRConfig } from 'swr';

import { TooltipProvider } from '@/components/ui/tooltip';

// next-intl is ESM (jest cannot parse it); resolve real en.json values through
// a MEMOIZED `t` — a fresh `t` per render invalidates the label memos in these
// components and makes the suite loop rather than fail.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
                }
            }
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockReplace = jest.fn();
let currentRunId = 'run_2';
// `useParams` is load-bearing here, not boilerplate: the published order is
// keyed by the route's tenantSlug, so the publisher and the reader only meet
// when both resolve the same slug.
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme', runId: currentRunId, planId: 'plan_1' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: (...a: unknown[]) => mockReplace(...a),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => `/t/acme/tests/runs/${currentRunId}`,
    useSearchParams: () => new URLSearchParams(),
}));

const mockUseTenantSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockUseTenantSWR(...args),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantContext: () => ({
        tenantSlug: 'acme',
        permissions: { canWrite: true, canAdmin: false, canRead: true },
    }),
}));

import { TestPlanDetailView } from '@/components/test-plans/TestPlanDetailView';
import TestRunPage from '@/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page';

/**
 * Three runs, in the order the API returns them (newest first) — which is
 * also the order the history renders, because that block applies no filter
 * and no client sort.
 */
const RUN_IDS = ['run_1', 'run_2', 'run_3'];

const PLAN = {
    id: 'plan_1',
    name: 'Quarterly access review evidence',
    description: null,
    method: 'MANUAL',
    frequency: 'QUARTERLY',
    status: 'ACTIVE',
    nextDueAt: null,
    automationType: 'MANUAL' as const,
    schedule: null,
    scheduleTimezone: null,
    nextRunAt: null,
    controlId: 'ctl_1',
    steps: [],
    runs: RUN_IDS.map((id, i) => ({
        id,
        status: 'COMPLETED',
        result: 'PASS',
        executedAt: `2026-0${i + 1}-01T00:00:00.000Z`,
        notes: null,
        executedBy: { name: `Runner ${i}`, email: `r${i}@example.test` },
        _count: { evidence: 0 },
    })),
    _count: { runs: 3, steps: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
};

const makeRun = (id: string) => ({
    id,
    status: 'COMPLETED',
    result: 'PASS',
    notes: null,
    findingSummary: null,
    executedAt: '2026-02-01T00:00:00.000Z',
    controlId: 'ctl_1',
    testPlanId: 'plan_1',
    testPlan: { id: 'plan_1', name: PLAN.name, controlId: 'ctl_1', frequency: 'QUARTERLY', steps: [] },
    executedBy: { name: 'Runner', email: 'r@example.test' },
    createdBy: { name: 'Runner', email: 'r@example.test' },
    evidence: [],
    createdAt: '2026-02-01T00:00:00.000Z',
});

/** One cache across two separate React trees — exactly what plan → run navigation produces. */
function makeSharedCache() {
    const cache = new Map();
    return function Wrapper({ children }: { children: React.ReactNode }) {
        return (
            <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false }}>
                {/* The app mounts one of these in `src/app/providers.tsx`; the
                    stepper's enabled arrow is wrapped in a Radix Tooltip and
                    throws without a provider ancestor. */}
                <TooltipProvider delayDuration={0}>{children}</TooltipProvider>
            </SWRConfig>
        );
    };
}

function answer(data: unknown) {
    return { data, isLoading: false, error: null, mutate: jest.fn() };
}

beforeEach(() => {
    mockReplace.mockReset();
    // jsdom has no global fetch; nothing under test calls it, but an
    // incidental probe throwing would fail the render rather than the assert.
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({}),
    }));
    currentRunId = 'run_2';
    mockUseTenantSWR.mockReset();
    mockUseTenantSWR.mockImplementation((key: unknown) => {
        if (typeof key !== 'string') return answer(undefined);
        if (key.startsWith('/tests/runs/')) return answer(makeRun(key.split('/').pop() as string));
        if (key === '/tests/plans/plan_1') return answer(PLAN);
        return answer(undefined);
    });
});

describe('test-run stepper', () => {
    it('steps to the run that follows in the rendered history order', () => {
        const Wrapper = makeSharedCache();

        // 1. The plan detail renders its run history and publishes that order.
        const plan = render(
            <Wrapper>
                <TestPlanDetailView planId="plan_1" context="tests" />
            </Wrapper>,
        );

        // Derive the order from the DOM rather than restating the literal, so
        // the assertion is "the stepper walks what is on screen".
        const renderedOrder = RUN_IDS.filter((id) =>
            plan.container.querySelector(`#test-run-link-${id}`),
        );
        expect(renderedOrder).toEqual(RUN_IDS);

        // 2. The run detail — a separate mount over the same cache.
        render(
            <Wrapper>
                <TestRunPage />
            </Wrapper>,
        );

        expect(screen.getByTestId('entity-prev-next-nav')).toBeInTheDocument();

        // Down arrow → the run AFTER run_2 in the rendered history.
        fireEvent.click(screen.getByTestId('entity-nav-next'));
        const next = renderedOrder[renderedOrder.indexOf('run_2') + 1];
        expect(mockReplace).toHaveBeenCalledWith(`/t/acme/tests/runs/${next}`);

        // Up arrow → the run BEFORE it.
        mockReplace.mockClear();
        fireEvent.click(screen.getByTestId('entity-nav-prev'));
        const prev = renderedOrder[renderedOrder.indexOf('run_2') - 1];
        expect(mockReplace).toHaveBeenCalledWith(`/t/acme/tests/runs/${prev}`);
    });

    it('disables the far end at the last run in the history', () => {
        const Wrapper = makeSharedCache();
        render(
            <Wrapper>
                <TestPlanDetailView planId="plan_1" context="tests" />
            </Wrapper>,
        );
        currentRunId = 'run_3';
        render(
            <Wrapper>
                <TestRunPage />
            </Wrapper>,
        );
        expect(screen.getByTestId('entity-nav-prev')).not.toBeDisabled();
        expect(screen.getByTestId('entity-nav-next')).toBeDisabled();
    });

    it('shows no arrows for a run opened without a run history on screen', () => {
        // "Run now" on /tests pushes straight to a freshly created run, and a
        // deep link does the same. Nothing published, so nothing to step —
        // hiding is the correct semantic, not a degradation.
        const Wrapper = makeSharedCache();
        render(
            <Wrapper>
                <TestRunPage />
            </Wrapper>,
        );
        expect(screen.queryByTestId('entity-prev-next-nav')).not.toBeInTheDocument();
    });
});
