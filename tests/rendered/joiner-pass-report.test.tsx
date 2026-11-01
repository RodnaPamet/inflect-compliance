/**
 * #4876 — the joiner pass report names each starter, speaks in words, and can
 * run a pass now.
 */
import * as React from 'react';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/identity-joiner-passes',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = ns.split('.').reduce((o: Record<string, unknown>, k) => (o?.[k] as Record<string, unknown>) ?? {}, en);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = (key: string) => t(key);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => {
    const apiUrl = (path: string) => `/api/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantApiUrl: () => apiUrl, useTenantHref: () => href };
});
jest.mock('@/components/nav/BackAffordance', () => ({ BackAffordance: () => null }));

let payload: unknown;
const mutate = jest.fn(async () => undefined);
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: payload, error: undefined, isLoading: !payload, mutate }),
}));

import { JoinerPassesClient } from '@/app/t/[tenantSlug]/(app)/admin/identity-joiner-passes/JoinerPassesClient';

const PASS = {
    id: 'pass-1',
    provider: 'entra-id',
    status: 'NOT_APPLICABLE',
    executedAt: '2026-10-30T04:30:00.000Z',
    completedAt: '2026-10-30T04:30:02.000Z',
    resultJson: {
        mode: 'DRY_RUN',
        starters: 2,
        wouldCreate: 1,
        created: 0,
        refusal: 'NO_DEFAULT_GROUP',
        detail: 'No default group is configured.',
        decisions: [
            { employeeId: 'emp-1', outcome: 'PLANNED', intendedAddress: 'ada.lovelace@acme.test' },
            { employeeId: 'emp-2', outcome: 'REFUSED_NO_START_DATE', reason: 'No start date in HR.' },
        ],
    },
};

beforeEach(() => {
    jest.clearAllMocks();
    payload = { passes: [PASS], starters: { 'emp-1': 'Ada Lovelace' } };
});

function openPass() {
    fireEvent.click(screen.getByText('Microsoft Entra ID'));
}

describe('the joiner pass report', () => {
    it('shows status, mode and provider in words', () => {
        render(<JoinerPassesClient />);
        expect(screen.getByText('Microsoft Entra ID')).toBeInTheDocument();
        expect(screen.getByText('Ran and refused')).toBeInTheDocument();
        expect(screen.getByText('Dry run')).toBeInTheDocument();
        for (const raw of ['entra-id', 'NOT_APPLICABLE', 'DRY_RUN']) {
            expect(document.body.textContent).not.toContain(raw);
        }
    });

    it('names each starter, and says when one is no longer in the roster', () => {
        render(<JoinerPassesClient />);
        openPass();
        const table = screen.getByTestId('joiner-pass-decisions-table');
        expect(within(table).getByText('Ada Lovelace')).toBeInTheDocument();
        expect(within(table).getByText('No longer in the HR roster')).toBeInTheDocument();
        expect(table.textContent).not.toContain('emp-1');
    });

    it('words each outcome and the refusal, and a held-back starter is not grey', () => {
        render(<JoinerPassesClient />);
        openPass();
        expect(screen.getByText('Planned')).toBeInTheDocument();
        const held = screen.getByText('Held: no start date');
        expect(held.closest('[class*="warning"]')).not.toBeNull();
        expect(screen.getByText('No default group is set up')).toBeInTheDocument();
        expect(document.body.textContent).not.toContain('NO_DEFAULT_GROUP');
    });

    it('Run now starts a pass and says it is queued', async () => {
        render(<JoinerPassesClient />);
        global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'queued' }) })) as unknown as typeof fetch;
        const run = document.getElementById('joiner-pass-run') as HTMLElement;
        await act(async () => {
            fireEvent.click(within(run).getByRole('button', { name: /Microsoft Entra ID/ }));
        });
        const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/identity-joiner-passes/run');
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({ provider: 'entra-id' });
        expect(await screen.findByText(/A Microsoft Entra ID pass is queued/)).toBeInTheDocument();
    });

    it('the breadcrumb starts at Dashboard', () => {
        render(<JoinerPassesClient />);
        expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/t/acme/dashboard');
    });
});
