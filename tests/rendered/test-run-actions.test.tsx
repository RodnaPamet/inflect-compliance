import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(() => 'toast-id'), dismiss: jest.fn(), success: jest.fn(),
        error: jest.fn(), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

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
let currentRunId = 'run_1';
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

const tenant: { current: Record<string, unknown> } = { current: {} };
jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantContext: () => tenant.current,
}));

import { toast } from 'sonner';
import TestRunPage from '@/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page';
import { __resetPendingUndoToastsForTest } from '@/components/ui/hooks/use-toast-with-undo';

/**
 * #4797 — the test run page: the confirm dialog names the result in words,
 * removing evidence waits out the undo window, a refused action says why,
 * and the evidence bundle is offered only to a role that may export.
 */

const WRITER = {
    tenantSlug: 'acme',
    permissions: { canWrite: true, canAdmin: false, canRead: true },
    appPermissions: {
        controls: { view: true, create: true, edit: true },
        tests: { view: true, create: true, execute: true },
        reports: { view: true, export: true },
    },
};
const READER = {
    tenantSlug: 'acme',
    permissions: { canWrite: false, canAdmin: false, canRead: true },
    appPermissions: {
        controls: { view: true, create: false, edit: false },
        tests: { view: true, create: false, execute: false },
        reports: { view: true, export: false },
    },
};

function makeRun(status: 'RUNNING' | 'COMPLETED') {
    return {
        id: 'run_1',
        status,
        result: status === 'COMPLETED' ? 'PASS' : null,
        notes: null,
        findingSummary: null,
        executedAt: status === 'COMPLETED' ? '2026-02-01T00:00:00.000Z' : null,
        controlId: 'ctl_1',
        testPlanId: 'plan_1',
        testPlan: { id: 'plan_1', name: 'Quarterly access review', controlId: 'ctl_1', frequency: 'QUARTERLY', steps: [] },
        executedBy: null,
        createdBy: { name: 'Runner', email: 'r@example.test' },
        evidence: [
            {
                id: 'link_1', kind: 'EVIDENCE', url: null, note: null, fileId: null, evidenceId: 'ev_1',
                evidence: { id: 'ev_1', title: 'Access review export', type: 'FILE' },
                createdBy: { name: 'Runner', email: 'r@example.test' },
                createdAt: '2026-02-01T00:00:00.000Z',
            },
        ],
        createdAt: '2026-02-01T00:00:00.000Z',
    };
}

let runStatus: 'RUNNING' | 'COMPLETED' = 'RUNNING';
const runMutate = jest.fn();
const fetchMock = jest.fn();

beforeEach(() => {
    __resetPendingUndoToastsForTest();
    tenant.current = WRITER;
    runStatus = 'RUNNING';
    runMutate.mockReset();
    (toast.error as jest.Mock).mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    mockUseTenantSWR.mockReset();
    mockUseTenantSWR.mockImplementation((key: unknown) => {
        if (key === '/tests/runs/run_1') return { data: makeRun(runStatus), isLoading: false, error: null, mutate: runMutate };
        return { data: undefined, isLoading: false, error: null, mutate: jest.fn() };
    });
});

afterEach(() => {
    jest.useRealTimers();
});

function renderPage() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false }}>
            <TooltipProvider delayDuration={0}>
                <TestRunPage />
            </TooltipProvider>
        </SWRConfig>,
    );
}

describe('test run — confirm dialog (#4797)', () => {
    it('names the result in words, not the stored value', async () => {
        renderPage();
        fireEvent.click(document.getElementById('complete-test-run-btn') as HTMLElement);
        expect((await screen.findAllByText(/Recording a Pass result freezes the evidence set/)).length).toBeGreaterThan(0);
        expect(screen.queryByText(/Recording a PASS result/)).not.toBeInTheDocument();
    });
});

describe('test run — removing evidence (#4797)', () => {
    it('waits out the undo window before the DELETE', async () => {
        jest.useFakeTimers();
        renderPage();
        fireEvent.click(screen.getByRole('button', { name: 'Unlink evidence' }));
        const deletes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
        expect(deletes()).toHaveLength(0);
        // The row leaves the list at once.
        expect(runMutate).toHaveBeenCalledWith(
            expect.objectContaining({ evidence: [] }),
            { revalidate: false },
        );
        await act(async () => {
            jest.advanceTimersByTime(5100);
        });
        expect(deletes()).toHaveLength(1);
        expect(String(deletes()[0][0])).toBe('/api/t/acme/tests/runs/run_1/evidence/link_1');
    });
});

describe('test run — refusals (#4797)', () => {
    it("a refused start says the server's reason", async () => {
        mockUseTenantSWR.mockImplementation((key: unknown) => {
            if (key === '/tests/runs/run_1') return { data: { ...makeRun('RUNNING'), status: 'PLANNED' }, isLoading: false, error: null, mutate: runMutate };
            return { data: undefined, isLoading: false, error: null, mutate: jest.fn() };
        });
        fetchMock.mockImplementation(async () => ({
            ok: false,
            status: 400,
            json: async () => ({ error: { code: 'BAD_REQUEST', message: 'Cannot start a run on a paused test plan' } }),
        }));
        renderPage();
        await act(async () => {
            fireEvent.click(document.getElementById('start-test-run-btn') as HTMLElement);
        });
        expect(toast.error).toHaveBeenCalledWith('Cannot start a run on a paused test plan', expect.anything());
    });

    it('a refused snapshot shows the reason, not the JSON body', async () => {
        runStatus = 'COMPLETED';
        mockUseTenantSWR.mockImplementation((key: unknown) => {
            if (key === '/tests/runs/run_1') return { data: makeRun('COMPLETED'), isLoading: false, error: null, mutate: runMutate };
            if (key === '/audits/packs') return { data: [{ id: 'pack_1', name: 'Q1 pack', status: 'DRAFT' }], isLoading: false, error: null, mutate: jest.fn() };
            return { data: undefined, isLoading: false, error: null, mutate: jest.fn() };
        });
        const body = { error: { code: 'BAD_REQUEST', message: 'The pack is no longer a draft' } };
        fetchMock.mockImplementation(async () => ({ ok: false, status: 400, json: async () => body, text: async () => JSON.stringify(body) }));
        renderPage();
        fireEvent.click(document.getElementById('snapshot-pack-select') as HTMLElement);
        fireEvent.click(await screen.findByRole('option', { name: 'Q1 pack' }));
        await act(async () => {
            fireEvent.click(document.getElementById('snapshot-to-pack-btn') as HTMLElement);
        });
        expect(toast.error).toHaveBeenCalledWith('The pack is no longer a draft', expect.anything());
    });
});

describe('test run — what a role is offered (#4797)', () => {
    it('a role that may not export sees no evidence-bundle links', () => {
        tenant.current = READER;
        renderPage();
        expect(document.getElementById('export-bundle-csv')).toBeNull();
        expect(document.getElementById('export-bundle-json')).toBeNull();
        expect(document.getElementById('complete-test-run-btn')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Unlink evidence' })).toBeNull();
    });

    it('a role that may export sees them', () => {
        renderPage();
        expect(document.getElementById('export-bundle-csv')).not.toBeNull();
    });
});
