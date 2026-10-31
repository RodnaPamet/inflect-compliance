import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

// A STABLE translator per namespace (the modal keys memos on `t`).
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        if (cache.has(ns)) return cache.get(ns);
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).split(`{${p}}`).join(String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(ns, key);
            return typeof v === 'string' ? v : key;
        };
        t.has = (key: string) => typeof resolve(ns, key) === 'string';
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/tests/dashboard',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({ permissions: { canWrite: true }, appPermissions: {}, tenantSlug: 'acme' }),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

type Answer = { data?: unknown; error?: unknown };
const answers: { metrics: (period: number) => Answer; readiness: Answer } = {
    metrics: () => ({}),
    readiness: {},
};
const requestedPeriods: number[] = [];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        const base = { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: jest.fn() };
        if (key?.startsWith('/tests/dashboard?period=')) {
            const period = Number(key.split('=')[1]);
            requestedPeriods.push(period);
            return { ...base, ...answers.metrics(period) };
        }
        if (key === '/tests/readiness') return { ...base, ...answers.readiness };
        return base;
    },
}));

import TestDashboardPage from '@/app/t/[tenantSlug]/(app)/tests/dashboard/page';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * #4798 — the tests dashboard: an empty period is not rated, a failed
 * coverage read is said, and the period switch reports its selection.
 */

function metrics(overrides: Record<string, unknown> = {}) {
    return {
        periodDays: 30, totalPlans: 4, totalRuns: 10, completedRuns: 8, passRuns: 6, failRuns: 2,
        inconclusiveRuns: 0, completionRate: 80, passRate: 75, failRate: 25, evidenceRate: 50,
        overduePlans: 1, repeatedFailures: [], runsWithEvidence: 4,
        ...overrides,
    };
}

beforeEach(() => {
    requestedPeriods.length = 0;
    answers.metrics = () => ({ data: metrics() });
    answers.readiness = { data: [] };
});

function renderPage() {
    return render(
        <TooltipProvider delayDuration={0}>
            <TestDashboardPage />
        </TooltipProvider>,
    );
}

describe('tests dashboard (#4798)', () => {
    it('a period with no runs shows no rate, not a red 0%', () => {
        answers.metrics = () => ({ data: metrics({ totalRuns: 0, completedRuns: 0, passRuns: 0, failRuns: 0, completionRate: 0, passRate: 0, failRate: 0, evidenceRate: 0, runsWithEvidence: 0 }) });
        renderPage();
        expect(screen.getAllByText('No runs in this period')).toHaveLength(4);
        expect(screen.queryByText('0%')).toBeNull();
    });

    it('a period with runs shows its rates', () => {
        renderPage();
        expect(screen.getByText('80%')).toBeInTheDocument();
        expect(screen.queryByText('No runs in this period')).toBeNull();
    });

    it('a failed coverage read is said, not hidden', () => {
        answers.readiness = { error: new Error('boom') };
        renderPage();
        expect(document.getElementById('framework-readiness-error')).toHaveTextContent("Couldn't load the framework test coverage.");
    });

    it('the period switch reports its selection and changes the period', () => {
        renderPage();
        const ninety = document.getElementById('period-90-btn') as HTMLElement;
        const thirty = document.getElementById('period-30-btn') as HTMLElement;
        expect(thirty).toHaveAttribute('aria-checked', 'true');
        expect(ninety).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(ninety);
        expect(requestedPeriods).toContain(90);
    });
});
