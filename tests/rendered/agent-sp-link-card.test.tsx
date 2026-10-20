/**
 * THE AGENT'S ENTRA SERVICE PRINCIPAL, rendered (#3807, the card for step 2c's
 * `/admin/agents/:agentId/service-principal-link`).
 *
 *   1. CONFIRMING IS THE SCANNER'S LINK, DELIBERATELY: one unconfirmed link
 *      offers Confirm, which opens a confirmation saying what it permits, and
 *      only that confirmation POSTs exactly `{ discoveredAgentId }`.
 *   2. NO LINK, OR MORE THAN ONE, OFFERS NOTHING to confirm: a disable names
 *      one principal, and the usecase's `confirmable` says whether it could.
 *   3. A confirmed link shows when, and a withdrawn confirmation stays in view
 *      with why, so an AUTOMATIC refusal is never unexplained.
 *   4. A refusal is the server's sentence, with the confirmation still open.
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

import { ServicePrincipalLinkCard } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/ServicePrincipalLinkCard';

const SP = '11111111-2222-3333-4444-555555555555';
const link = (id: string, confirmation: Record<string, unknown> | null = null) => ({
    discoveredAgentId: id,
    servicePrincipalId: SP,
    lastSeenAt: '2026-10-20T03:10:00.000Z',
    confirmation,
});

function mockFetch(response: { ok: boolean; error?: string } = { ok: true }) {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return { ok: response.ok, json: async () => (response.ok ? { created: true } : { error: response.error }) } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

const renderCard = () => render(<ServicePrincipalLinkCard tenantSlug="acme" agentId="agt_1" />);

beforeEach(() => {
    jest.clearAllMocks();
    payload = { agentId: 'agt_1', links: [link('da_1')], confirmable: true, confirmations: [] };
});

describe('confirming the link', () => {
    it('POSTs exactly { discoveredAgentId } only after the confirmation', async () => {
        const calls = mockFetch();
        renderCard();

        fireEvent.click(screen.getByTestId('agent-sp-link-confirm-da_1'));
        expect(calls).toHaveLength(0);

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(SP);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm link' }));

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/admin/agents/agt_1/service-principal-link',
            method: 'POST',
            body: { discoveredAgentId: 'da_1' },
        });
        await waitFor(() => expect(swrMutate).toHaveBeenCalled());
    });

    it("keeps the confirmation open over the server's refusal", async () => {
        mockFetch({ ok: false, error: 'The harness no longer links that principal to this agent alone.' });
        renderCard();

        fireEvent.click(screen.getByTestId('agent-sp-link-confirm-da_1'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm link' }));

        expect(await screen.findByTestId('agent-sp-link-confirm-error')).toHaveTextContent(
            'The harness no longer links that principal to this agent alone.',
        );
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
});

describe('what it offers', () => {
    it('offers nothing when no scan links a principal', () => {
        payload = { agentId: 'agt_1', links: [], confirmable: false, confirmations: [] };
        renderCard();
        expect(screen.getByTestId('agent-sp-link-none')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    });

    it('offers nothing to confirm when a scan links more than one principal', () => {
        payload = { agentId: 'agt_1', links: [link('da_1'), link('da_2')], confirmable: false, confirmations: [] };
        renderCard();
        expect(screen.getByTestId('agent-sp-link-ambiguous')).toHaveTextContent('links 2 principals');
        expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    });

    it('shows a confirmed link, and a withdrawn confirmation with why', () => {
        const live = {
            discoveredAgentId: 'da_1',
            discoveredId: `entra:sp:${SP}`,
            confirmedAt: '2026-10-19T09:00:00.000Z',
            invalidatedAt: null,
            invalidatedReason: null,
        };
        payload = {
            agentId: 'agt_1',
            links: [link('da_1', live)],
            confirmable: true,
            confirmations: [
                live,
                {
                    ...live,
                    confirmedAt: '2026-10-10T09:00:00.000Z',
                    invalidatedAt: '2026-10-12T03:00:00.000Z',
                    invalidatedReason: 'AGENT_RELINKED',
                },
            ],
        };
        renderCard();
        expect(screen.getByTestId('agent-sp-link-da_1')).toHaveTextContent('Confirmed');
        expect(screen.queryByTestId('agent-sp-link-confirm-da_1')).not.toBeInTheDocument();
        expect(screen.getByTestId('agent-sp-link-history')).toHaveTextContent(
            'a scan linked this agent to another principal',
        );
    });
});
