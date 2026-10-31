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
    usePathname: () => '/t/acme/controls',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/controls/dashboard',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantContext: () => ({
        permissions: { canWrite: true, canAdmin: true, canRead: true },
        appPermissions: {},
        role: 'ADMIN',
        tenantSlug: 'acme',
    }),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useMoneyFormatter: () => (n: number) => `€${n}`,
}));

type Answer = { data?: unknown; error?: unknown; isLoading?: boolean; isValidating?: boolean; mutate?: jest.Mock };
const answers: Record<string, Answer> = {};
const consistencyMutate = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        if (key === null) return { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: jest.fn() };
        const base = key.startsWith('/controls/best-value') ? answers['/controls/best-value'] : answers[key];
        return { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: jest.fn(), ...(base ?? {}) };
    },
}));

import ControlsDashboard from '@/app/t/[tenantSlug]/(app)/controls/dashboard/page';
import { TooltipProvider } from '@/components/ui/tooltip';

/**
 * #4793 — the controls dashboard says when a read failed instead of showing
 * zeros, runs its consistency check visibly, and no card links to more rows
 * than it counts.
 */

const DASHBOARD = {
    totalControls: 12,
    statusDistribution: { IMPLEMENTED: 6, NOT_STARTED: 6 },
    applicabilityDistribution: { applicable: 10, notApplicable: 2 },
    overdueTasks: 3,
    controlsDueSoon: 2,
    topOwners: [],
    implementationProgress: 60,
    implementedCount: 6,
    applicableCount: 10,
    controlsMissingEvidence: 4,
};

beforeEach(() => {
    for (const k of Object.keys(answers)) delete answers[k];
    answers['/controls/dashboard'] = { data: DASHBOARD };
    answers['/controls/health-verdicts'] = { data: { counts: { HEALTHY: 1, DEGRADED: 0, AT_RISK: 0, NOT_APPLICABLE: 0, UNKNOWN: 0 } } };
    answers['/controls/best-value'] = { data: [] };
    consistencyMutate.mockReset();
});

function renderPage() {
    return render(
        <TooltipProvider delayDuration={0}>
            <ControlsDashboard />
        </TooltipProvider>,
    );
}

describe('controls dashboard — failed reads (#4793)', () => {
    it('a failed health read says so instead of showing zero tiles', () => {
        answers['/controls/health-verdicts'] = { error: new Error('boom') };
        renderPage();
        expect(screen.getByText("Couldn't load control health.")).toBeInTheDocument();
        expect(document.getElementById('control-health-summary')).toBeNull();
    });

    it('a failed best-value read is not "no control qualifies yet"', () => {
        answers['/controls/best-value'] = { error: new Error('boom') };
        renderPage();
        expect(screen.getByTestId('best-value-controls-error')).toHaveTextContent("Couldn't load the best-value controls.");
        expect(screen.queryByTestId('best-value-controls-empty')).toBeNull();
    });
});

describe('controls dashboard — cards (#4793)', () => {
    it('the overdue-tasks card links nowhere, because no list holds exactly its rows', () => {
        renderPage();
        const card = document.getElementById('overdue-tasks') as HTMLElement;
        expect(card).not.toBeNull();
        expect(card.closest('a')).toBeNull();
        expect(screen.getByText('open tasks on controls, past their due date')).toBeInTheDocument();
    });

    it('the due-soon caption says it includes overdue controls', () => {
        renderPage();
        expect(screen.getByText('overdue, or due within 30 days')).toBeInTheDocument();
    });
});

describe('controls dashboard — consistency check (#4793)', () => {
    it('shows that it is running', () => {
        renderPage();
        fireEvent.click(document.getElementById('consistency-check-btn') as HTMLElement);
        expect(document.getElementById('consistency-checking')).toHaveTextContent('Running the consistency check…');
    });

    it('says when it could not run', () => {
        answers['/controls/consistency-check'] = { error: new Error('forbidden') };
        renderPage();
        fireEvent.click(document.getElementById('consistency-check-btn') as HTMLElement);
        expect(document.getElementById('consistency-error')).toHaveTextContent("Couldn't run the consistency check. Try again.");
    });

    it('a second click runs it again', () => {
        answers['/controls/consistency-check'] = {
            data: { summary: { missingCodeCount: 0, duplicateCodeCount: 0, overdueTaskCount: 0 }, issues: { missingCode: [], duplicateCodes: [], overdueTasks: [] } },
            mutate: consistencyMutate,
        };
        renderPage();
        fireEvent.click(document.getElementById('consistency-check-btn') as HTMLElement);
        expect(document.getElementById('consistency-results')).not.toBeNull();
        expect(consistencyMutate).not.toHaveBeenCalled();
        fireEvent.click(document.getElementById('consistency-check-btn') as HTMLElement);
        expect(consistencyMutate).toHaveBeenCalledTimes(1);
    });
});
