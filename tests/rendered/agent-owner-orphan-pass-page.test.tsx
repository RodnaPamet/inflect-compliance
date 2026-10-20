/**
 * THE OWNER-ORPHAN PASS PAGE, rendered (#3807, the page for step 2b's route).
 *
 *   1. THE NEXT RUNG ONLY, CONFIRMED. Widening opens a confirmation and PUTs
 *      exactly `{ mode }` with the next rung; nothing is sent until it is
 *      confirmed.
 *   2. NARROWING IS ONE CLICK, never confirmed: it is the emergency stop.
 *   3. THE REFUSAL IS SHOWN beside the disabled control, and a refused widen
 *      keeps the confirmation open over the server's sentence.
 *   4. THE PASSES ARE THE RECORD: each pass shows its refusal, or what it found
 *      and did per orphan, linked to the agent. No pass yet is said in words.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/agents/owner-orphan-pass',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = (en as Record<string, unknown>)[ns] ?? {};
        const t = (key: string, values?: Record<string, string | number>) => {
            const v = key.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
            if (typeof v !== 'string') return key;
            return values ? v.replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m)) : v;
        };
        t.rich = t;
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

let payload: Record<string, unknown> | undefined;
const swrMutate = jest.fn(async () => undefined);
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: payload, error: undefined, isLoading: !payload, mutate: swrMutate }),
}));

import { OwnerOrphanPassClient } from '@/app/t/[tenantSlug]/(app)/agents/owner-orphan-pass/OwnerOrphanPassClient';

type Mode = 'DISABLED' | 'DRY_RUN' | 'AUTOMATIC';

function setPayload(mode: Mode, over: Record<string, unknown> = {}) {
    const ladder: Mode[] = ['DISABLED', 'DRY_RUN', 'AUTOMATIC'];
    payload = {
        mode,
        dryRunSince: null,
        nextMode: ladder[ladder.indexOf(mode) + 1] ?? null,
        blockedReason: null,
        dryRunMinDays: 7,
        maxMode: 'AUTOMATIC',
        passes: [],
        ...over,
    };
}

function mockFetch(response: { ok: boolean; error?: string } = { ok: true }) {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return { ok: response.ok, json: async () => (response.ok ? {} : { error: response.error }) } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

const modeCard = () => screen.getByRole('region', { name: 'Owner-orphan pass' });

beforeEach(() => {
    jest.clearAllMocks();
    setPayload('DISABLED');
});

describe('the mode', () => {
    it('widens one rung only after the confirmation, with exactly { mode }', async () => {
        const calls = mockFetch();
        render(<OwnerOrphanPassClient />);

        fireEvent.click(within(modeCard()).getByRole('button', { name: 'Widen to Dry run' }));
        expect(calls).toHaveLength(0);

        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Widen to Dry run' }));

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/admin/agents/owner-orphan-pass',
            method: 'PUT',
            body: { mode: 'DRY_RUN' },
        });
        await waitFor(() => expect(swrMutate).toHaveBeenCalled());
    });

    it('narrows in one click, with no confirmation', async () => {
        setPayload('AUTOMATIC');
        const calls = mockFetch();
        render(<OwnerOrphanPassClient />);

        fireEvent.click(within(modeCard()).getByRole('button', { name: 'Narrow to Dry run' }));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].body).toEqual({ mode: 'DRY_RUN' });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows the dwell refusal beside the disabled widen control', () => {
        setPayload('DRY_RUN', {
            dryRunSince: '2026-10-19T00:00:00.000Z',
            blockedReason: 'Must remain in DRY_RUN for 7 days before widening.',
        });
        render(<OwnerOrphanPassClient />);
        expect(within(modeCard()).getByRole('button', { name: 'Widen to Automatic' })).toBeDisabled();
        expect(within(modeCard()).getByText('Must remain in DRY_RUN for 7 days before widening.')).toBeInTheDocument();
    });

    it("keeps the confirmation open over the server's refusal", async () => {
        mockFetch({ ok: false, error: 'Cannot widen more than one rung at a time.' });
        render(<OwnerOrphanPassClient />);

        fireEvent.click(within(modeCard()).getByRole('button', { name: 'Widen to Dry run' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Widen to Dry run' }));

        expect(await screen.findByTestId('orphan-pass-confirm-error')).toHaveTextContent(
            'Cannot widen more than one rung at a time.',
        );
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
});

describe('the recorded passes', () => {
    it('says so when no pass has run', () => {
        render(<OwnerOrphanPassClient />);
        expect(screen.getByTestId('orphan-passes-none')).toBeInTheDocument();
    });

    it('shows a refusal pass by its refusal, and a dry run by what it found per orphan', () => {
        setPayload('DRY_RUN', {
            passes: [
                {
                    id: 'pass_2',
                    status: 'NOT_APPLICABLE',
                    executedAt: '2026-10-20T05:15:00.000Z',
                    resultJson: {
                        mode: 'DRY_RUN',
                        refusal: null,
                        counts: { orphans: 1, contained: 0, failed: 0, wouldContain: 1 },
                        hrRoster: { read: true },
                        decisions: [
                            {
                                agentId: 'agt_orphan',
                                signals: [{ kind: 'MEMBERSHIP_NOT_ACTIVE', membership: 'DEACTIVATED' }],
                                outcome: 'WOULD_SUSPEND_AND_KILL',
                                transferTask: { status: 'NO_MANAGER_KNOWN' },
                                servicePrincipal: { status: 'WOULD_REQUEST' },
                            },
                        ],
                    },
                },
                {
                    id: 'pass_1',
                    status: 'NOT_APPLICABLE',
                    executedAt: '2026-10-19T05:15:00.000Z',
                    resultJson: { mode: 'DISABLED', refusal: 'MODE_DISABLED' },
                },
            ],
        });
        render(<OwnerOrphanPassClient />);

        expect(screen.getByTestId('orphan-pass-refusal-pass_1')).toHaveTextContent('Off: no owner was checked.');
        expect(screen.getByTestId('orphan-pass-counts-pass_2')).toHaveTextContent('1 orphan(s) found. Nothing was changed.');
        const decision = screen.getByTestId('orphan-decision-pass_2-agt_orphan');
        expect(within(decision).getByRole('link', { name: 'agt_orphan' })).toHaveAttribute('href', '/t/acme/agents/agt_orphan');
        expect(decision).toHaveTextContent('Would be stopped and suspended');
        expect(decision).toHaveTextContent('MEMBERSHIP_NOT_ACTIVE:DEACTIVATED');
        expect(decision).toHaveTextContent('Service principal: WOULD_REQUEST');
    });
});
