/**
 * THE AGENT'S BEHAVIOUR FINGERPRINT, rendered (Morpheus roadmap 1.3, the
 * Overview card over `/admin/agents/:agentId/behaviour-fingerprint`).
 *
 *   1. AN EMPTY CARD SAYS WHETHER ANYBODY LOOKED: detector off, on but
 *      unscored, and scored-with-nothing are three different sentences.
 *   2. THE "WHY" names each driving feature with its count, the agent's own
 *      mean and σ, and the z.
 *   3. ACCEPTING A NEW NORMAL IS OFFERED ONLY WHERE THE SERVER SAID YES, and
 *      only the confirmation POSTs the confirmation literal.
 *   4. AN OPEN BREAKER points to its close rather than offering a way round it.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    usePathname: () => '/t/acme/agents/agt_1',
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

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('sonner', () => ({ toast: mockToast, Toaster: () => null }));

let payload: Record<string, unknown> | undefined;
const swrMutate = jest.fn(async () => undefined);
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: payload, error: undefined, isLoading: !payload, mutate: swrMutate }),
}));

import { BehaviourFingerprintCard } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourFingerprintCard';

const anomaly = {
    id: 'an_1',
    agentId: 'agt_1',
    day: '2026-09-21',
    score: 23.4,
    tier: 'LATCH',
    drivers: [{ feature: 'readCalls', observed: 360, mean: 119.5, sd: 10.25, z: 23.4 }],
    findingId: 'f_1',
    latchedAt: null,
    createdAt: '2026-09-22T01:53:00.000Z',
};

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        agentId: 'agt_1',
        detector: { on: true, basis: 'ON', latch: false },
        thresholds: { zFinding: 4, zLatch: 8, baselineMinDays: 14, baselineMaxDays: 28, lookbackDays: 90 },
        lastScoredDay: '2026-09-21',
        days: [{ day: '2026-09-21', verdict: 'ANOMALOUS', score: 23.4, baselineDays: 20, inBaseline: false }],
        anomalies: [anomaly],
        baselineEpoch: null,
        acceptBaseline: { allowed: true, refusal: null },
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

const renderCard = () => render(<BehaviourFingerprintCard tenantSlug="acme" agentId="agt_1" />);

beforeEach(() => {
    jest.clearAllMocks();
    payload = base();
});

describe('an empty card says whether anybody looked', () => {
    it('detector off for the workspace: says nobody looked, never "no anomalies"', () => {
        payload = base({ detector: { on: false, basis: 'TENANT_NOT_NAMED', latch: false }, lastScoredDay: null, days: [], anomalies: [], acceptBaseline: { allowed: false, refusal: 'NOTHING_TO_ACCEPT' } });
        renderCard();
        expect(screen.getByTestId('agent-fingerprint-off')).toHaveTextContent('not for this workspace');
        expect(screen.queryByTestId('agent-fingerprint-none')).not.toBeInTheDocument();
    });

    it('detector on, agent never scored: says unscored, never "no anomalies"', () => {
        payload = base({ lastScoredDay: null, days: [], anomalies: [], acceptBaseline: { allowed: false, refusal: 'NOTHING_TO_ACCEPT' } });
        renderCard();
        expect(screen.getByTestId('agent-fingerprint-unscored')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-fingerprint-none')).not.toBeInTheDocument();
    });

    it('scored with nothing found: says so, and offers nothing', () => {
        payload = base({ days: [{ day: '2026-09-21', verdict: 'STEADY', score: 0, baselineDays: 20, inBaseline: true }], anomalies: [], acceptBaseline: { allowed: false, refusal: 'NOTHING_TO_ACCEPT' } });
        renderCard();
        expect(screen.getByTestId('agent-fingerprint-none')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Accept as new normal' })).not.toBeInTheDocument();
    });
});

describe('the why', () => {
    it('names the driving feature with its count, the mean, σ and z', () => {
        renderCard();
        expect(screen.getByTestId('behaviour-why-readCalls')).toHaveTextContent(
            'Read calls 360 against a baseline mean of 119.50 (σ 10.25, z 23.40)',
        );
    });
});

describe('accepting the new normal', () => {
    it('POSTs the confirmation literal only after the confirmation', async () => {
        const calls = mockFetch();
        renderCard();
        fireEvent.click(screen.getByRole('button', { name: 'Accept as new normal' }));
        expect(calls).toHaveLength(0);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Both behaviour detectors');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Accept new baseline' }));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/admin/agents/agt_1/behaviour-fingerprint',
            method: 'POST',
            body: { confirm: 'ACCEPT_NEW_BASELINE' },
        });
    });

    it("keeps the confirmation open over the server's refusal", async () => {
        mockFetch({ ok: false, error: 'There is no behaviour anomaly since the last accepted baseline.' });
        renderCard();
        fireEvent.click(screen.getByRole('button', { name: 'Accept as new normal' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Accept new baseline' }));
        expect(await screen.findByTestId('agent-fingerprint-accept-error')).toHaveTextContent(
            'There is no behaviour anomaly since the last accepted baseline.',
        );
    });

    it('is not offered where the server said no', () => {
        payload = base({ acceptBaseline: { allowed: false, refusal: 'NOT_A_PERSON' } });
        renderCard();
        expect(screen.queryByRole('button', { name: 'Accept as new normal' })).not.toBeInTheDocument();
    });

    it('an open breaker points to its close instead', () => {
        payload = base({ acceptBaseline: { allowed: false, refusal: 'BREAKER_OPEN' } });
        renderCard();
        expect(screen.getByTestId('agent-fingerprint-breaker-open')).toHaveTextContent('Circuit breaker tab');
        expect(screen.queryByRole('button', { name: 'Accept as new normal' })).not.toBeInTheDocument();
    });
});
