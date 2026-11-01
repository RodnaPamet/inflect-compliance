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
            if (!values) return v;
            // A simple ICU plural, formatted for real (#4903's counts use them).
            const plural = v.replace(
                /\{(\w+), plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g,
                (_m, name: string, one: string, other: string) =>
                    (Number(values[name]) === 1 ? one : other).replace(/#/g, String(values[name])),
            );
            return plural.replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m));
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

const modeCard = () => screen.getByRole('region', { name: 'Owner departure check' });

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

    // #4903: the server's English sentence named modes by their codes. When the
    // structured refusal is there, the page words it instead.
    it('words a structured refusal rather than showing the server sentence', () => {
        setPayload('DRY_RUN', {
            dryRunSince: '2026-10-19T00:00:00.000Z',
            blockedReason: 'Dry-run has been active for 2 of 7 required days.',
            blockedRefusal: { code: 'DWELL', days: 2, required: 7, left: 5 },
        });
        render(<OwnerOrphanPassClient />);
        expect(
            within(modeCard()).getByText(
                'Dry run has lasted 2 of 7 days. 5 more to go, so the agents it reports can be compared with who actually left.',
            ),
        ).toBeInTheDocument();
        expect(within(modeCard()).queryByText(/Dry-run has been active/)).toBeNull();
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
        expect(screen.getByTestId('orphan-pass-counts-pass_2')).toHaveTextContent(
            '1 agent without an owner found. Nothing was changed.',
        );
        const decision = screen.getByTestId('orphan-decision-pass_2-agt_orphan');
        // With no name known, the link falls back to the id it targets.
        expect(within(decision).getByRole('link', { name: 'agt_orphan' })).toHaveAttribute('href', '/t/acme/agents/agt_orphan');
        expect(decision).toHaveTextContent('Would be stopped and suspended');
        // #4903: the signal is worded, not printed as `kind:membership`.
        expect(decision).toHaveTextContent('Membership: deactivated');
        expect(decision).not.toHaveTextContent('MEMBERSHIP_NOT_ACTIVE');
        // A service-principal outcome this build has no words for is shown as stored.
        expect(decision).toHaveTextContent('Service principal: WOULD_REQUEST');
        // The pass status is a label, not its code.
        expect(screen.getByTestId('orphan-pass-pass_2')).toHaveTextContent('Did not check');
        expect(screen.getByTestId('orphan-pass-pass_2')).toHaveTextContent('Mode: Dry run');
    });

    it('names each agent the pass decided about, and words a known service-principal outcome', () => {
        setPayload('AUTOMATIC', {
            agentNames: { agt_orphan: 'Access reviewer' },
            passes: [
                {
                    id: 'pass_3',
                    status: 'PASSED',
                    executedAt: '2026-10-21T05:15:00.000Z',
                    resultJson: {
                        mode: 'AUTOMATIC',
                        refusal: null,
                        counts: { orphans: 2, contained: 2, failed: 0 },
                        decisions: [
                            {
                                agentId: 'agt_orphan',
                                signals: [{ kind: 'HR_TERMINATED' }],
                                outcome: 'SUSPENDED_AND_KILLED',
                                servicePrincipal: { status: 'LINK_UNCONFIRMED' },
                            },
                        ],
                    },
                },
            ],
        });
        render(<OwnerOrphanPassClient />);
        const decision = screen.getByTestId('orphan-decision-pass_3-agt_orphan');
        expect(within(decision).getByRole('link', { name: 'Access reviewer' })).toHaveAttribute(
            'href',
            '/t/acme/agents/agt_orphan',
        );
        expect(decision).toHaveTextContent('HR records them as left');
        expect(decision).toHaveTextContent('Nobody has confirmed this agent’s service principal link');
        expect(screen.getByTestId('orphan-pass-counts-pass_3')).toHaveTextContent(
            '2 agents without an owner: 2 stopped, 0 not fully stopped.',
        );
    });

});
