/** @jest-environment jsdom */

/**
 * REMOVING A BIA DEPENDENCY (#5313, Epic 67).
 *
 * The row leaves the list on click and the DELETE is sent when the undo window
 * closes. Undo puts it back. A refused DELETE puts it back AND shows the
 * server's reason: it used to stay silent after the "removed" toast, so a
 * refusal read as a removal.
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

const toastError = jest.fn();
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, {
        custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
        error: (...a: unknown[]) => toastError(...a), warning: jest.fn(), info: jest.fn(),
        message: jest.fn(), loading: jest.fn(),
    }),
}));

type Trigger = {
    action: () => Promise<unknown>;
    undoAction?: () => void;
    onError?: (e: unknown) => void;
};
const triggers: Trigger[] = [];
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return { ...actual, useToastWithUndo: () => (input: Trigger) => { triggers.push(input); return 'toast-1'; } };
});

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            const str = typeof val === 'string' ? val : key;
            return params
                ? str.replace(/\{(\w+)\}/g, (m, n) =>
                    Object.prototype.hasOwnProperty.call(params, n) ? String(params[n]) : m)
                : str;
        };
        t.rich = t; t.markup = t; t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/audits/business-continuity/bia-1',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`,
    useTenantHref: () => (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`,
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { BiaDetailClient, type BiaDetail } from '@/app/t/[tenantSlug]/(app)/audits/business-continuity/[id]/BiaDetailClient';

const AUDITS = jest.requireActual('../../messages/en.json').audits;

const DETAIL = {
    id: 'bia-1', name: 'Payments ledger', criticality: 'CRITICAL',
    rtoHours: 4, rpoHours: 1, mtpdHours: 24,
    impactProfile: [{ atHours: 4, financial: 2 }],
    notes: null, reviewedAt: null, processNode: null, ownerUser: null,
    dependencies: [{ id: 'dep-1', dependsOnType: 'ASSET', dependsOnId: 'a-1', targetName: 'Ledger DB', targetPath: '/assets/a-1' }],
    linkedControls: [], evidenceLinks: [],
    recovery: { rank: 1, rationale: 'CRITICAL criticality · MTPD 24h · RTO 4h → recovery #1' },
} as unknown as BiaDetail;

function mount() {
    return render(
        <SWRConfig value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}>
            <TooltipProvider delayDuration={0}>
                <BiaDetailClient bia={DETAIL} tenantSlug="acme" canWrite />
            </TooltipProvider>
        </SWRConfig>,
    );
}

const fetchMock = jest.fn();
beforeEach(() => {
    triggers.length = 0;
    toastError.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ options: [] }) }));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

function removeLedger() {
    fireEvent.click(screen.getByRole('button', { name: /^Remove.*Ledger DB/ }));
}

it('takes the row off the list at once, and Undo puts it back', () => {
    mount();
    expect(screen.getByText('Ledger DB')).toBeInTheDocument();
    removeLedger();
    expect(screen.queryByText('Ledger DB')).toBeNull();
    expect(triggers).toHaveLength(1);
    act(() => triggers[0].undoAction?.());
    expect(screen.getByText('Ledger DB')).toBeInTheDocument();
});

it("a refused DELETE puts the row back and shows the server's reason", async () => {
    mount();
    removeLedger();
    fetchMock.mockImplementation(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'You may not change this analysis.' } }),
    }));
    let caught: unknown;
    await act(async () => {
        await triggers[0].action().catch((e) => { caught = e; });
    });
    act(() => triggers[0].onError?.(caught));
    expect(screen.getByText('Ledger DB')).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith('You may not change this analysis.', expect.anything());
});

it('a refusal with no reason says the dependency was not removed', async () => {
    mount();
    removeLedger();
    act(() => triggers[0].onError?.(new Error('')));
    expect(toastError).toHaveBeenCalledWith(AUDITS.biaDetail.removeDependencyFailed, expect.anything());
    expect(screen.getByText('Ledger DB')).toBeInTheDocument();
});
