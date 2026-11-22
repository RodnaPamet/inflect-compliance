/**
 * AN AGENT'S SPENDING AUTHORITY, rendered (Agent Pay Phase 1, #5333; the card
 * for `/admin/agents/:agentId/spending-authority`).
 *
 *   1. THE CARD OFFERS A WRITE ONLY WHERE THE SERVER TAKES IT: each act
 *      follows the server's answer for this viewer, and nothing is offered to
 *      a viewer the page's register gate refuses, whatever the server says.
 *   2. A withheld review says WHY (the declarer, the owner), rather than a
 *      button that silently is not there.
 *   3. Reviewing POSTs exactly the declaration the reviewer read, and only
 *      after the confirmation; withdrawing is a DELETE of the rail.
 *   4. An unreviewed envelope, and one a kill asked to be suspended, are said
 *      in words.
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

import { SpendingAuthorityCard } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SpendingAuthorityCard';

const DECLARED_AT = '2026-11-18T09:00:00.000Z';

function envelope(over: Record<string, unknown> = {}) {
    return {
        id: 'sa_1',
        agentId: 'agt_1',
        rail: 'AGENT_PAY_TOKEN',
        status: 'DECLARED',
        perTransactionLimitMinor: '5000',
        periodBudgetMinor: '50000',
        budgetPeriod: 'MONTH',
        currency: 'EUR',
        merchantDomains: ['shop.example.com'],
        merchantCategoryCodes: ['4511'],
        merchantScopeUnrestricted: false,
        expiresAt: '2027-02-01T00:00:00.000Z',
        consentedByUserId: 'u_consenter',
        tokenRequestor: 'Example Agent Platform',
        tokenReference: 'REF-123',
        declaredByUserId: 'u_declarer',
        declaredAt: DECLARED_AT,
        reviewedByUserId: null,
        reviewedAt: null,
        suspensionRequestedAt: null,
        withdrawnAt: null,
        unreviewed: true,
        viewerMayReview: true,
        reviewWithheld: null,
        viewerMayNarrow: true,
        viewerMayWithdraw: true,
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

const people = [
    { id: 'u_consenter', label: 'Cara Consenter' },
    { id: 'u_declarer', label: 'Dan Declarer' },
];

const renderCard = (canManageRegistry = true) =>
    render(
        <SpendingAuthorityCard tenantSlug="acme" agentId="agt_1" canManageRegistry={canManageRegistry} people={people} />,
    );

beforeEach(() => {
    jest.clearAllMocks();
    payload = { agentId: 'agt_1', agentStatus: 'DRAFT', viewerMayDeclare: true, envelopes: [envelope()] };
});

describe('what the card shows', () => {
    it('says the register records none, and offers a declaration to a viewer the server lets declare', () => {
        payload = { agentId: 'agt_1', agentStatus: 'DRAFT', viewerMayDeclare: true, envelopes: [] };
        renderCard();
        expect(screen.getByTestId('agent-spending-none')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Declare' })).toBeInTheDocument();
    });

    it('shows the envelope with names, not ids, and says it is unreviewed', () => {
        renderCard();
        const row = screen.getByTestId('agent-spending-AGENT_PAY_TOKEN');
        expect(row).toHaveTextContent('Mastercard Agent Pay token');
        expect(row).toHaveTextContent('Awaiting review');
        expect(row).toHaveTextContent('Cara Consenter');
        expect(row).toHaveTextContent('Dan Declarer');
        expect(row).toHaveTextContent('shop.example.com');
        expect(screen.getByTestId('agent-spending-unreviewed-AGENT_PAY_TOKEN')).toBeInTheDocument();
    });

    it('names the token requestor when a kill asked for the token to be suspended', () => {
        payload = {
            agentId: 'agt_1',
            agentStatus: 'SUSPENDED',
            viewerMayDeclare: true,
            envelopes: [envelope({ status: 'SUSPENDED_REQUESTED', suspensionRequestedAt: '2026-11-19T10:00:00.000Z', viewerMayReview: false, reviewWithheld: 'NOT_DECLARED' })],
        };
        renderCard();
        expect(screen.getByTestId('agent-spending-AGENT_PAY_TOKEN')).toHaveTextContent(
            'Ask Example Agent Platform to suspend it',
        );
    });
});

describe('the card offers a write only where the server takes it', () => {
    it('offers nothing to a viewer the page’s register gate refuses, whatever the server says', () => {
        renderCard(false);
        expect(screen.queryByRole('button', { name: 'Declare' })).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-spending-review-AGENT_PAY_TOKEN')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-spending-narrow-AGENT_PAY_TOKEN')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-spending-withdraw-AGENT_PAY_TOKEN')).not.toBeInTheDocument();
    });

    it('withholds the review from the declarer and says why', () => {
        payload = {
            agentId: 'agt_1',
            agentStatus: 'DRAFT',
            viewerMayDeclare: true,
            envelopes: [envelope({ viewerMayReview: false, reviewWithheld: 'REVIEWER_IS_DECLARER' })],
        };
        renderCard();
        expect(screen.queryByTestId('agent-spending-review-AGENT_PAY_TOKEN')).not.toBeInTheDocument();
        expect(screen.getByTestId('agent-spending-review-withheld-AGENT_PAY_TOKEN')).toHaveTextContent(
            'You declared this envelope, so someone else reviews it.',
        );
    });

    it('offers no narrowing or withdrawal the server would refuse', () => {
        payload = {
            agentId: 'agt_1',
            agentStatus: 'RETIRED',
            viewerMayDeclare: false,
            envelopes: [envelope({ status: 'WITHDRAWN', viewerMayReview: false, reviewWithheld: 'AGENT_RETIRED', viewerMayNarrow: false, viewerMayWithdraw: false })],
        };
        renderCard();
        expect(screen.queryByTestId('agent-spending-narrow-AGENT_PAY_TOKEN')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-spending-withdraw-AGENT_PAY_TOKEN')).not.toBeInTheDocument();
        expect(screen.queryByTestId('agent-spending-redeclare-AGENT_PAY_TOKEN')).not.toBeInTheDocument();
    });
});

describe('the acts', () => {
    it('reviews exactly the declaration it read, only after the confirmation', async () => {
        const calls = mockFetch();
        renderCard();
        fireEvent.click(screen.getByTestId('agent-spending-review-AGENT_PAY_TOKEN'));
        expect(calls).toHaveLength(0);
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as reviewed' }));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/admin/agents/agt_1/spending-authority/AGENT_PAY_TOKEN/review',
            method: 'POST',
            body: { declaredAt: DECLARED_AT },
        });
        await waitFor(() => expect(swrMutate).toHaveBeenCalled());
    });

    it("keeps the review open over the server's refusal", async () => {
        mockFetch({ ok: false, error: 'The envelope was declared again while you were reviewing it.' });
        renderCard();
        fireEvent.click(screen.getByTestId('agent-spending-review-AGENT_PAY_TOKEN'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as reviewed' }));
        expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
            'The envelope was declared again while you were reviewing it.',
        );
    });

    it('withdraws by deleting the rail, behind a revoke confirmation', async () => {
        const calls = mockFetch();
        renderCard();
        fireEvent.click(screen.getByTestId('agent-spending-withdraw-AGENT_PAY_TOKEN'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke spending authority' }));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/admin/agents/agt_1/spending-authority/AGENT_PAY_TOKEN',
            method: 'DELETE',
            body: undefined,
        });
    });

    it('a narrowing sends the envelope back with its stored expiry untouched, in minor units', async () => {
        const calls = mockFetch();
        renderCard();
        fireEvent.click(screen.getByTestId('agent-spending-narrow-AGENT_PAY_TOKEN'));
        const form = await screen.findByTestId('agent-spending-form');
        fireEvent.change(within(form).getByLabelText(/Per-transaction limit/), { target: { value: '25.5' } });
        fireEvent.click(screen.getByTestId('agent-spending-save'));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].url).toBe('/api/t/acme/admin/agents/agt_1/spending-authority/AGENT_PAY_TOKEN');
        expect(calls[0].method).toBe('PATCH');
        expect(calls[0].body).toEqual({
            rail: 'AGENT_PAY_TOKEN',
            perTransactionLimitMinor: 2550,
            periodBudgetMinor: 50000,
            budgetPeriod: 'MONTH',
            currency: 'EUR',
            merchantDomains: ['shop.example.com'],
            merchantCategoryCodes: ['4511'],
            expiresAt: '2027-02-01T00:00:00.000Z',
            consentedByUserId: 'u_consenter',
            tokenRequestor: 'Example Agent Platform',
            tokenReference: 'REF-123',
        });
    });
});
