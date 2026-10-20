/**
 * AN AGENT'S OWNERSHIP TRANSFER, rendered (#3807, the card for step 2a's
 * `/admin/agents/:agentId/ownership-transfer`).
 *
 *   1. STEP ONE: with no open transfer, a key holder proposes a new owner, and
 *      the card POSTs exactly `{ toOwnerUserId }`. The picker leaves out the
 *      current owner and the viewer, whom the usecase refuses; any other
 *      refusal is the server's sentence.
 *   2. STEP TWO IS THE RECIPIENT'S: only the person an open transfer names is
 *      offered Accept, through a confirmation, which POSTs exactly
 *      `{ transferId }` to `complete`. The person who started it is offered
 *      Withdraw and never Accept.
 *   3. CLOSING WAITS OUT THE UNDO WINDOW: decline, withdraw and cancel send
 *      the DELETE only after it, and Undo sends nothing.
 *   4. A retired agent is offered no proposal.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

const mockToast = {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    dismiss: jest.fn(),
    custom: jest.fn(() => 'toast-1'),
};
jest.mock('sonner', () => ({ toast: mockToast, Toaster: () => null }));

let payload: Record<string, unknown> | undefined;
const swrMutate = jest.fn(async () => undefined);
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: () => ({ data: payload, error: undefined, isLoading: !payload, mutate: swrMutate }),
}));

import { OwnershipTransferCard } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OwnershipTransferCard';

const OWNERS = [
    { id: 'u_owner', label: 'Olga Owner' },
    { id: 'u_me', label: 'Mia Me' },
    { id: 'u_ai', label: 'Ari AI-admin' },
];

const transfer = (over: Record<string, unknown> = {}) => ({
    id: 'tr_1',
    fromOwnerUserId: 'u_owner',
    toOwnerUserId: 'u_ai',
    initiatedByUserId: 'u_owner',
    status: 'PENDING',
    effectiveStatus: 'PENDING',
    expiresAt: '2026-10-27T10:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    ...over,
});

function mockFetch(response: { ok: boolean; error?: string } = { ok: true }) {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return { ok: response.ok, json: async () => (response.ok ? {} : { error: response.error }) } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

const onChanged = jest.fn();
const renderCard = (viewerUserId = 'u_me', retired = false) =>
    render(
        <OwnershipTransferCard
            tenantSlug="acme"
            agentId="agt_1"
            viewerUserId={viewerUserId}
            owners={OWNERS}
            retired={retired}
            onChanged={onChanged}
        />,
    );

afterEach(() => {
    jest.useRealTimers();
});

beforeEach(() => {
    jest.clearAllMocks();
    payload = { agentId: 'agt_1', ownerUserId: 'u_owner', open: null, history: [] };
});

describe('step one: proposing', () => {
    it('POSTs exactly { toOwnerUserId }, offering neither the owner nor the viewer', async () => {
        const calls = mockFetch();
        renderCard();
        expect(screen.getByTestId('agent-ownership-owner')).toHaveTextContent('Owner: Olga Owner');
        expect(screen.getByTestId('agent-ownership-propose-submit')).toBeDisabled();

        fireEvent.click(screen.getByRole('combobox'));
        const listbox = await screen.findByRole('listbox');
        expect(within(listbox).queryByText('Olga Owner')).not.toBeInTheDocument();
        expect(within(listbox).queryByText('Mia Me')).not.toBeInTheDocument();
        fireEvent.click(within(listbox).getByText('Ari AI-admin'));

        fireEvent.click(screen.getByTestId('agent-ownership-propose-submit'));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/admin/agents/agt_1/ownership-transfer',
            method: 'POST',
            body: { toOwnerUserId: 'u_ai' },
        });
        await waitFor(() => expect(swrMutate).toHaveBeenCalled());
    });

    it("shows the server's refusal of a recipient who could not accept", async () => {
        mockFetch({ ok: false, error: 'The new owner must hold the agent ownership permission.' });
        renderCard();
        fireEvent.click(screen.getByRole('combobox'));
        fireEvent.click(within(await screen.findByRole('listbox')).getByText('Ari AI-admin'));
        fireEvent.click(screen.getByTestId('agent-ownership-propose-submit'));
        expect(await screen.findByTestId('agent-ownership-propose-error')).toHaveTextContent(
            'The new owner must hold the agent ownership permission.',
        );
    });

    it('offers no proposal on a retired agent', () => {
        renderCard('u_me', true);
        expect(screen.getByTestId('agent-ownership-retired')).toBeInTheDocument();
        expect(screen.queryByTestId('agent-ownership-propose')).not.toBeInTheDocument();
    });
});

describe('step two: an open transfer', () => {
    it('offers the person it names Accept, confirmed, POSTing exactly { transferId }', async () => {
        payload = { agentId: 'agt_1', ownerUserId: 'u_owner', open: transfer(), history: [] };
        const calls = mockFetch();
        renderCard('u_ai');

        fireEvent.click(screen.getByTestId('agent-ownership-accept'));
        expect(calls).toHaveLength(0);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('in place of Olga Owner');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Accept ownership' }));

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/admin/agents/agt_1/ownership-transfer/complete',
            method: 'POST',
            body: { transferId: 'tr_1' },
        });
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it("keeps the confirmation open over the server's refusal", async () => {
        payload = { agentId: 'agt_1', ownerUserId: 'u_owner', open: transfer(), history: [] };
        mockFetch({ ok: false, error: 'This agent changed owner after the transfer was proposed.' });
        renderCard('u_ai');
        fireEvent.click(screen.getByTestId('agent-ownership-accept'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Accept ownership' }));
        expect(await screen.findByTestId('agent-ownership-accept-error')).toHaveTextContent(
            'This agent changed owner after the transfer was proposed.',
        );
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('offers the person who started it Withdraw, never Accept', () => {
        payload = {
            agentId: 'agt_1',
            ownerUserId: 'u_owner',
            open: transfer({ initiatedByUserId: 'u_me' }),
            history: [],
        };
        renderCard('u_me');
        expect(screen.queryByTestId('agent-ownership-accept')).not.toBeInTheDocument();
        expect(screen.getByTestId('agent-ownership-open')).toHaveTextContent('Only Ari AI-admin can accept it.');
        expect(screen.getByTestId('agent-ownership-close')).toHaveTextContent('Withdraw');
    });

    it('sends the DELETE only after the undo window', async () => {
        jest.useFakeTimers();
        payload = { agentId: 'agt_1', ownerUserId: 'u_owner', open: transfer(), history: [] };
        const calls = mockFetch();
        renderCard('u_ai');

        fireEvent.click(screen.getByTestId('agent-ownership-decline'));
        expect(screen.queryByTestId('agent-ownership-open')).not.toBeInTheDocument();
        expect(calls).toHaveLength(0);

        await act(async () => {
            jest.advanceTimersByTime(5000);
        });
        expect(calls).toEqual([
            { url: '/api/t/acme/admin/agents/agt_1/ownership-transfer?transferId=tr_1', method: 'DELETE', body: undefined },
        ]);
    });
});

it('lists past transfers by their status now', () => {
    payload = {
        agentId: 'agt_1',
        ownerUserId: 'u_owner',
        open: null,
        history: [transfer({ id: 'tr_0', status: 'PENDING', effectiveStatus: 'EXPIRED' })],
    };
    renderCard();
    expect(screen.getByTestId('agent-ownership-history')).toHaveTextContent('Expired');
    expect(screen.getByTestId('agent-ownership-history')).toHaveTextContent('Olga Owner → Ari AI-admin');
});
