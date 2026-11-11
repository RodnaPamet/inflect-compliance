/**
 * A2A PEER INVITATIONS, rendered (#3752; owner decisions 2026-11-11).
 *
 *   1. INVITE sends exactly the schema's fields, is offered only once every
 *      one is chosen, and the code it returns is shown once, then gone.
 *   2. ACCEPT reads the inviter's card before anything can be approved, shows
 *      its text and hash, and approves THAT hash; editing the code puts the
 *      card back to unread.
 *   3. A refusal is the server's sentence.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
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

import {
    AcceptInvitationForm,
    InvitationCodePanel,
    InvitePeerForm,
} from '@/app/t/[tenantSlug]/(app)/agents/peers/PeerInvitationForms';

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

async function choose(id: string, label: string) {
    fireEvent.click(document.getElementById(id)!);
    fireEvent.click(within(await screen.findByRole('listbox')).getByText(label));
}

const choices = {
    owners: [{ id: 'u_1', label: 'Olga Owner' }],
    vendors: [{ id: 'v_1', label: 'Partner Ltd' }],
    agents: [{ id: 'ag_1', label: 'Receiver' }],
    workflows: [{ id: 'diagnostic', label: 'Diagnostic' }],
};

async function fillGrant(prefix: string) {
    await choose(`${prefix}-owner`, 'Olga Owner');
    await choose(`${prefix}-vendor`, 'Partner Ltd');
    await choose(`${prefix}-risk-tier`, 'Moderate');
    await choose(`${prefix}-agent`, 'Receiver');
    await choose(`${prefix}-workflows`, 'Diagnostic');
}

const GRANT = { ownerUserId: 'u_1', vendorId: 'v_1', riskTier: 'MODERATE', receivingAgentId: 'ag_1', workflowKeys: ['diagnostic'] };
const CODE = `https://inflect.example/api/a2a/other/agent-card.json#iflinv_${'a'.repeat(43)}`;

beforeEach(() => jest.clearAllMocks());

describe('inviting a peer', () => {
    it('sends exactly the schema fields once every one is chosen, and hands back the code', async () => {
        const calls = mockFetch([{ ok: true, body: { invitation: { id: 'inv_1' }, code: CODE } }]);
        const onCreated = jest.fn();
        render(<InvitePeerForm choices={choices} onCreated={onCreated} onCancel={jest.fn()} />);
        expect(screen.getByTestId('peer-invite-submit')).toBeDisabled();
        await fillGrant('peer-invite');
        fireEvent.click(screen.getByTestId('peer-invite-submit'));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({ url: '/api/t/acme/admin/agents/peers/invitations', method: 'POST', body: GRANT });
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CODE));
    });

    it("shows the server's refusal", async () => {
        mockFetch([{ ok: false, body: { error: 'Generate this workspace\'s signing key on the peers page before inviting a peer.' } }]);
        render(<InvitePeerForm choices={choices} onCreated={jest.fn()} onCancel={jest.fn()} />);
        await fillGrant('peer-invite');
        fireEvent.click(screen.getByTestId('peer-invite-submit'));
        expect(await screen.findByTestId('peer-invite-error')).toHaveTextContent('signing key');
    });

    it('shows the code once, with a warning, until Done', () => {
        const onDone = jest.fn();
        render(<InvitationCodePanel code={CODE} onDone={onDone} />);
        expect(screen.getByTestId('peer-invite-code')).toHaveTextContent(CODE);
        expect(screen.getByTestId('peer-invite-code-panel')).toHaveTextContent('shown only once');
        fireEvent.click(screen.getByTestId('peer-invite-code-done'));
        expect(onDone).toHaveBeenCalled();
    });
});

describe('accepting an invitation', () => {
    const HASH = 'c'.repeat(64);
    const preview = {
        cardUrl: 'https://inflect.example/api/a2a/other/agent-card.json',
        card: { name: 'Inflect', url: 'https://inflect.example/api/a2a/other' },
        cardHash: HASH,
        keyFingerprint: 'f'.repeat(64),
    };

    it('reads the card first, shows it, and approves the hash that was read', async () => {
        const calls = mockFetch([
            { ok: true, body: preview },
            { ok: true, body: { peerId: 'peer_9', connectionId: 'conn_9' } },
        ]);
        const onAccepted = jest.fn();
        render(<AcceptInvitationForm choices={choices} onAccepted={onAccepted} onCancel={jest.fn()} />);
        expect(screen.queryByTestId('peer-accept-submit')).not.toBeInTheDocument();
        fireEvent.change(document.getElementById('peer-accept-code')!, { target: { value: CODE } });
        fireEvent.click(screen.getByTestId('peer-accept-read'));
        await waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0]).toEqual({ url: '/api/t/acme/admin/agents/peers/invitations/preview', method: 'POST', body: { invitation: CODE } });
        expect(await screen.findByTestId('peer-accept-card-hash')).toHaveTextContent(HASH);
        expect(screen.getByTestId('peer-accept-card-text')).toHaveTextContent('https://inflect.example/api/a2a/other');
        // The card's own name fills the name, which the person may change.
        expect(document.getElementById('peer-accept-name')).toHaveValue('Inflect');

        expect(screen.getByTestId('peer-accept-submit')).toBeDisabled();
        await fillGrant('peer-accept');
        fireEvent.click(screen.getByTestId('peer-accept-submit'));
        await waitFor(() => expect(calls).toHaveLength(2));
        expect(calls[1]).toEqual({
            url: '/api/t/acme/admin/agents/peers/invitations/accept',
            method: 'POST',
            body: { invitation: CODE, reviewedCardHash: HASH, name: 'Inflect', ...GRANT },
        });
        await waitFor(() => expect(onAccepted).toHaveBeenCalledWith({ peerId: 'peer_9', name: 'Inflect' }));
    });

    it('editing the code puts the card back to unread', async () => {
        mockFetch([{ ok: true, body: preview }]);
        render(<AcceptInvitationForm choices={choices} onAccepted={jest.fn()} onCancel={jest.fn()} />);
        fireEvent.change(document.getElementById('peer-accept-code')!, { target: { value: CODE } });
        fireEvent.click(screen.getByTestId('peer-accept-read'));
        expect(await screen.findByTestId('peer-accept-preview')).toBeInTheDocument();
        fireEvent.change(document.getElementById('peer-accept-code')!, { target: { value: `${CODE}x` } });
        expect(screen.queryByTestId('peer-accept-preview')).not.toBeInTheDocument();
        expect(screen.getByTestId('peer-accept-read')).toBeInTheDocument();
    });

    it("shows the server's refusal", async () => {
        mockFetch([{ ok: false, body: { error: 'That is not an A2A peer invitation. Paste the whole code you were sent.' } }]);
        render(<AcceptInvitationForm choices={choices} onAccepted={jest.fn()} onCancel={jest.fn()} />);
        fireEvent.change(document.getElementById('peer-accept-code')!, { target: { value: 'nonsense' } });
        fireEvent.click(screen.getByTestId('peer-accept-read'));
        expect(await screen.findByTestId('peer-accept-error')).toHaveTextContent('not an A2A peer invitation');
    });
});
