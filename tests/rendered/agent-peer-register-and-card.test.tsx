/**
 * REGISTERING AN A2A PEER AND APPROVING ITS CARD, rendered (#3807, the forms
 * for step 2e's `/admin/agents/peers` and `…/card/approve`).
 *
 *   1. REGISTER sends exactly the schema's fields — a risk tier only when one
 *      is chosen — and is not offered until every required field is filled.
 *      A refusal is the server's sentence.
 *   2. NO TRUST ON FIRST USE: reading the card shows its text, its hash and how
 *      it compares with the pin; approving names THAT hash
 *      (`{ expectedCardHash }`), only through a confirmation, and a refusal
 *      keeps the confirmation open.
 *   3. A card that matches the pin, or that could not be read, offers nothing
 *      to approve; nor does a reader without the register key.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const routerRefresh = jest.fn();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: routerRefresh, back: jest.fn() }),
    usePathname: () => '/t/acme/agents/peers',
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

import { RegisterPeerForm } from '@/app/t/[tenantSlug]/(app)/agents/peers/RegisterPeerForm';
import { PeerCardReview } from '@/app/t/[tenantSlug]/(app)/agents/peers/[peerId]/PeerCardReview';

type Call = { url: string; method?: string; body: unknown };

function mockFetch(answers: Array<{ ok: boolean; body: unknown }>) {
    const calls: Call[] = [];
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const answer = answers.length > 1 ? answers.shift()! : answers[0];
        return { ok: answer.ok, json: async () => answer.body } as Response;
    }) as unknown as typeof fetch;
    return calls;
}

/** Open a Combobox by id and pick an option by its label. */
async function choose(id: string, label: string) {
    fireEvent.click(document.getElementById(id)!);
    fireEvent.click(within(await screen.findByRole('listbox')).getByText(label));
}

beforeEach(() => jest.clearAllMocks());

describe('registering a peer', () => {
    const onRegistered = jest.fn();
    const renderForm = () =>
        render(
            <RegisterPeerForm
                owners={[{ id: 'u_1', label: 'Olga Owner' }]}
                vendors={[{ id: 'v_1', label: 'Partner Ltd' }]}
                onRegistered={onRegistered}
                onCancel={jest.fn()}
            />,
        );

    async function fillRequired() {
        fireEvent.change(document.getElementById('peer-register-name')!, { target: { value: 'Partner agent' } });
        fireEvent.change(document.getElementById('peer-register-card-url')!, {
            target: { value: 'https://partner.example/.well-known/agent-card.json' },
        });
        fireEvent.change(document.getElementById('peer-register-signing-key')!, { target: { value: 'ab'.repeat(32) } });
        await choose('peer-register-owner', 'Olga Owner');
        await choose('peer-register-vendor', 'Partner Ltd');
    }

    it('sends exactly the schema fields, and only once every required one is filled', async () => {
        const calls = mockFetch([{ ok: true, body: { peer: { id: 'peer_1', name: 'Partner agent' }, card: { readable: true } } }]);
        renderForm();
        expect(screen.getByTestId('peer-register-submit')).toBeDisabled();

        await fillRequired();
        fireEvent.click(screen.getByTestId('peer-register-submit'));

        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({
            url: '/api/t/acme/admin/agents/peers',
            method: 'POST',
            body: {
                name: 'Partner agent',
                cardUrl: 'https://partner.example/.well-known/agent-card.json',
                signingPublicKey: 'ab'.repeat(32),
                ownerUserId: 'u_1',
                vendorId: 'v_1',
            },
        });
        await waitFor(() => expect(onRegistered).toHaveBeenCalledWith(expect.objectContaining({ peer: { id: 'peer_1', name: 'Partner agent' } })));
    });

    it('sends a risk tier when one is chosen', async () => {
        const calls = mockFetch([{ ok: true, body: { peer: { id: 'peer_1', name: 'Partner agent' }, card: { readable: true } } }]);
        renderForm();
        await fillRequired();
        await choose('peer-register-risk-tier', 'High');
        fireEvent.click(screen.getByTestId('peer-register-submit'));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect((calls[0].body as Record<string, unknown>).riskTier).toBe('HIGH');
    });

    it("shows the server's refusal", async () => {
        mockFetch([{ ok: false, body: { error: 'signingPublicKey is not an Ed25519 public key (raw 32 bytes, hex or base64)' } }]);
        renderForm();
        await fillRequired();
        fireEvent.click(screen.getByTestId('peer-register-submit'));
        expect(await screen.findByTestId('peer-register-error')).toHaveTextContent('is not an Ed25519 public key');
        expect(onRegistered).not.toHaveBeenCalled();
    });
});

describe("reviewing and approving a peer's card", () => {
    const HASH = 'c'.repeat(64);
    const unpinnedRead = {
        peerId: 'peer_1',
        live: { readable: true, hashes: { cardHash: HASH }, card: { name: 'Partner agent', url: 'https://partner.example/a2a' } },
        verdict: { status: 'UNPINNED' },
        admission: { admitted: false, reason: 'PEER_UNPINNED' },
    };

    it('shows the text and hash it read, and approves THAT hash through a confirmation', async () => {
        const calls = mockFetch([
            { ok: true, body: unpinnedRead },
            { ok: true, body: { peerId: 'peer_1', revision: 1, cardHash: HASH, alreadyPinned: false } },
        ]);
        render(<PeerCardReview peerId="peer_1" retired={false} canManage />);
        expect(calls).toHaveLength(0);

        fireEvent.click(screen.getByTestId('peer-card-read'));
        expect(await screen.findByTestId('peer-card-live-hash')).toHaveTextContent(HASH);
        expect(screen.getByTestId('peer-card-text')).toHaveTextContent('https://partner.example/a2a');
        expect(screen.getByTestId('peer-card-admission')).toHaveTextContent('PEER_UNPINNED');

        fireEvent.click(screen.getByTestId('peer-card-approve'));
        expect(calls).toHaveLength(1);
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(HASH);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Approve card' }));

        await waitFor(() => expect(calls).toHaveLength(2));
        expect(calls[1]).toEqual({
            url: '/api/t/acme/admin/agents/peers/peer_1/card/approve',
            method: 'POST',
            body: { expectedCardHash: HASH },
        });
        await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    });

    it('keeps the confirmation open when the card moved since it was read', async () => {
        mockFetch([
            { ok: true, body: unpinnedRead },
            { ok: false, body: { error: 'The live card differs from the one reviewed. Read it again before approving' } },
        ]);
        render(<PeerCardReview peerId="peer_1" retired={false} canManage />);
        fireEvent.click(screen.getByTestId('peer-card-read'));
        fireEvent.click(await screen.findByTestId('peer-card-approve'));
        const dialog = await screen.findByRole('dialog');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Approve card' }));
        expect(await screen.findByTestId('peer-card-approve-error')).toHaveTextContent('differs from the one reviewed');
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('offers nothing to approve for a matching card, an unreadable card, or a reader without the key', async () => {
        mockFetch([{ ok: true, body: { ...unpinnedRead, verdict: { status: 'MATCH', revision: 1 }, admission: { admitted: true } } }]);
        const { unmount } = render(<PeerCardReview peerId="peer_1" retired={false} canManage />);
        fireEvent.click(screen.getByTestId('peer-card-read'));
        expect(await screen.findByTestId('peer-card-admission')).toHaveTextContent('would be admitted');
        expect(screen.queryByTestId('peer-card-approve')).not.toBeInTheDocument();
        unmount();

        mockFetch([{ ok: true, body: { ...unpinnedRead, live: { readable: false, reason: 'HTTP_ERROR' }, verdict: null } }]);
        const second = render(<PeerCardReview peerId="peer_1" retired={false} canManage />);
        fireEvent.click(screen.getByTestId('peer-card-read'));
        expect(await screen.findByTestId('peer-card-unreadable')).toHaveTextContent('HTTP_ERROR');
        expect(screen.queryByTestId('peer-card-approve')).not.toBeInTheDocument();
        second.unmount();

        mockFetch([{ ok: true, body: unpinnedRead }]);
        render(<PeerCardReview peerId="peer_1" retired={false} canManage={false} />);
        fireEvent.click(screen.getByTestId('peer-card-read'));
        expect(await screen.findByTestId('peer-card-live-hash')).toBeInTheDocument();
        expect(screen.queryByTestId('peer-card-approve')).not.toBeInTheDocument();
    });
});
