/**
 * THE A2A PEERS PAGES, rendered (#3679; owner decision 2026-10-19).
 *
 *   1. THE LIST shows each peer's pin and card state and quota, and the
 *      tenant's own signing key above it — public key and key id only. With no
 *      key the page says A2A is refused both ways; only an owner is offered
 *      generate / rotate, and the rotation POSTs and refreshes.
 *   2. THE PEER PAGE: the kill switch engages with a reason (POST) and lifts
 *      with one (PATCH), and is not offered without the kill key; an inbound
 *      credential is issued with an agent and workflows (POST) and its token is
 *      shown ONCE; revoking is confirmed with the canonical verb (DELETE); the
 *      quota saves as a number (PATCH); every message shows whether its
 *      receipt verifies.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const mockRefresh = jest.fn();
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: mockRefresh, back: jest.fn(), prefetch: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/peers',
    useSearchParams: () => new URLSearchParams(''),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    InfoTooltip: ({ content }: { content: string }) => <span>{content}</span>,
    DynamicTooltipWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn(), dismiss: jest.fn() };
jest.mock('sonner', () => ({ toast: mockToast, Toaster: () => null }));

import { PeersClient, type PeerRow } from '@/app/t/[tenantSlug]/(app)/agents/peers/PeersClient';
import type { SigningKeyView } from '@/app/t/[tenantSlug]/(app)/agents/peers/SigningKeyPanel';
import { PeerDetailClient, type PeerDetail } from '@/app/t/[tenantSlug]/(app)/agents/peers/[peerId]/PeerDetailClient';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a nested message catalogue read for its strings
const P = (jest.requireActual('../../messages/en.json') as { agents: { peers: Record<string, any> } }).agents.peers;

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const KEY = {
    id: 'key-1',
    publicKey: 'c'.repeat(64),
    fingerprint: 'd'.repeat(64),
    createdAt: '2026-10-19T08:00:00.000Z',
    retiredAt: null,
};

const ROWS: PeerRow[] = [
    {
        id: 'peerpinned1',
        name: 'Pinned partner',
        cardUrl: 'https://partner.example/.well-known/agent.json',
        status: 'ACTIVE',
        pinnedCardHash: HASH_A,
        pinRevision: 2,
        observedCardHash: HASH_A,
        inboundMessagesPerHour: 60,
        ownerName: null,
        vendorName: null,
    },
    {
        id: 'peerdrifted1',
        name: 'Drifted partner',
        cardUrl: 'https://drift.example/.well-known/agent.json',
        status: 'SUSPENDED',
        pinnedCardHash: HASH_A,
        pinRevision: 1,
        observedCardHash: HASH_B,
        inboundMessagesPerHour: 5,
        ownerName: null,
        vendorName: null,
    },
    {
        id: 'peerunpinned',
        name: 'New partner',
        cardUrl: 'https://new.example/.well-known/agent.json',
        status: 'ACTIVE',
        pinnedCardHash: null,
        pinRevision: 0,
        observedCardHash: HASH_B,
        inboundMessagesPerHour: 60,
        ownerName: null,
        vendorName: null,
    },
];

const keyView = (over: Partial<SigningKeyView> = {}): SigningKeyView => ({
    current: KEY,
    retired: [],
    canRotate: true,
    ...over,
});

const renderList = (signingKey: SigningKeyView = keyView()) =>
    render(<PeersClient tenantSlug="acme" initialRows={ROWS} signingKey={signingKey} canReviewProposals canCompose />);

let fetchMock: jest.Mock;
beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

describe('the peers list', () => {
    it('shows each peer\'s pin, card state and quota', () => {
        renderList();
        expect(screen.getByTestId('peers-table')).toBeTruthy();
        expect(screen.getByTestId('peer-pin-peerpinned1').textContent).toBe(P.pinRevision.replace('{revision}', '2'));
        expect(screen.getByTestId('peer-pin-peerunpinned').textContent).toBe(P.pinNone);
        expect(screen.getByTestId('peer-card-peerpinned1').textContent).toBe(P.cardMatches);
        expect(screen.getByTestId('peer-card-peerdrifted1').textContent).toBe(P.cardChanged);
        expect(screen.getByText(P.quotaValue.replace('{count}', '5'))).toBeTruthy();
    });

    // #4901: a card that was read but never approved used to read "Changed
    // since the pin" beside "Not pinned".
    it('a peer never approved reads "not approved yet", not "changed"', () => {
        renderList();
        expect(screen.getByTestId('peer-card-peerunpinned').textContent).toBe(P.cardUnapproved);
        expect(screen.getByTestId('peer-card-peerunpinned').textContent).not.toBe(P.cardChanged);
    });

    it('names each peer\'s owner and supplier', () => {
        render(
            <PeersClient
                tenantSlug="acme"
                initialRows={[{ ...ROWS[0], ownerName: 'Ana Petrova', vendorName: 'Partner Ltd' }]}
                signingKey={keyView()}
                canReviewProposals
                canCompose
            />,
        );
        expect(screen.getByText('Ana Petrova')).toBeTruthy();
        expect(screen.getByText('Partner Ltd')).toBeTruthy();
    });

    it('the register form says when there is no supplier to choose, and links to Vendors', () => {
        renderList();
        fireEvent.click(screen.getByTestId('peer-register-open'));
        expect(screen.getByTestId('peer-register-no-vendors').textContent).toContain(P.register.vendorsEmpty);
        expect(screen.getByRole('link', { name: P.register.vendorsLink }).getAttribute('href')).toBe('/t/acme/vendors');
    });

    it('the register form says when the member list could not be loaded', () => {
        render(
            <PeersClient
                tenantSlug="acme"
                initialRows={ROWS}
                signingKey={keyView()}
                canReviewProposals
                canCompose
                ownersUnavailable
            />,
        );
        fireEvent.click(screen.getByTestId('peer-register-open'));
        expect(screen.getByTestId('peer-register-owners-unavailable').textContent).toBe(P.register.ownersUnavailable);
    });

    it('a row opens its peer', () => {
        renderList();
        fireEvent.click(screen.getByTestId('peer-row-peerdrifted1'));
        expect(mockPush).toHaveBeenCalledWith('/t/acme/agents/peers/peerdrifted1');
    });

    it('shows the tenant\'s own public key and key id, never anything else', () => {
        renderList();
        const panel = screen.getByTestId('peers-signing-key');
        expect(within(panel).getByTestId('peers-signing-key-public').textContent).toBe(KEY.publicKey);
        expect(within(panel).getByTestId('peers-signing-key-fingerprint').textContent).toBe(KEY.fingerprint);
        expect(within(panel).getByText(P.signingKey.rotate)).toBeTruthy();
    });

    it('with no key, says A2A is refused both ways and offers an owner Generate', () => {
        renderList(keyView({ current: null }));
        expect(screen.getByTestId('peers-signing-key-none').textContent).toContain(P.signingKey.none);
        expect(screen.getByTestId('peers-signing-key-rotate').textContent).toBe(P.signingKey.generate);
    });

    it('offers no rotation to a reader who is not an owner, and says who can', () => {
        renderList(keyView({ canRotate: false }));
        expect(screen.queryByTestId('peers-signing-key-rotate')).toBeNull();
        expect(screen.getByTestId('peers-signing-key-owner-only').textContent).toBe(P.signingKey.ownerOnly);
    });

    it('a confirmed rotation POSTs to the key route and refreshes', async () => {
        renderList();
        await userEvent.click(screen.getByTestId('peers-signing-key-rotate'));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getAllByText(P.signingKey.rotateTitle).length).toBeGreaterThan(0);
        await userEvent.click(within(dialog).getByRole('button', { name: P.signingKey.rotate }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/agents/a2a-signing-key', { method: 'POST' }));
        await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    });
});

// ─── The peer page ───────────────────────────────────────────────────────────

const detail = (over: Partial<PeerDetail> = {}): PeerDetail => ({
    peer: {
        id: 'peerpinned1',
        name: 'Pinned partner',
        cardUrl: 'https://partner.example/.well-known/agent.json',
        status: 'ACTIVE',
        signingKeyFingerprint: 'e'.repeat(64),
        pinnedCardHash: HASH_A,
        pinRevision: 2,
        pinnedAt: '2026-10-18T08:00:00.000Z',
        observedCardHash: HASH_A,
        observedAt: '2026-10-19T08:00:00.000Z',
        inboundMessagesPerHour: 60,
    },
    credential: {
        live: null,
        revoked: [],
        handover: { inflectIdentity: 'https://app.inflect.test/api/a2a/acme/agent-card.json', endpointPath: '/api/a2a/acme', signingPublicKey: KEY.publicKey },
    },
    messages: [
        { id: 'm1', direction: 'INBOUND', kind: 'TASK', method: 'message/send', messageId: 'msg-1', signerKeyFingerprint: 'e'.repeat(64), createdAt: '2026-10-19T08:01:00.000Z', verifies: true },
        { id: 'm2', direction: 'OUTBOUND', kind: 'RESULT', method: null, messageId: 'msg-2', signerKeyFingerprint: KEY.fingerprint, createdAt: '2026-10-19T08:01:01.000Z', verifies: false },
        { id: 'm3', direction: 'OUTBOUND', kind: 'TASK', method: 'message/send', messageId: 'msg-3', signerKeyFingerprint: 'f'.repeat(64), createdAt: '2026-10-19T08:02:00.000Z', verifies: null },
    ],
    kills: [],
    agents: [{ id: 'agent-1', name: 'Reconciler' }],
    workflows: [{ key: 'diagnostic', name: 'Diagnostic' }],
    ...over,
});

const renderDetail = (d: PeerDetail = detail(), perms: { canManage?: boolean; canKill?: boolean } = {}) =>
    render(<PeerDetailClient tenantSlug="acme" detail={d} canManage={perms.canManage ?? true} canKill={perms.canKill ?? true} />);

const openTab = async (label: string) => {
    await userEvent.click(screen.getByRole('tab', { name: new RegExp(label) }));
};

describe('one peer: the kill switch', () => {
    it('engages with a reason, as a POST', async () => {
        renderDetail();
        await openTab(P.detail.tabKill);
        expect(screen.getByTestId('peer-kill-clear')).toBeTruthy();
        // No reason, no stop: the API refuses a blank one and so does the form.
        expect((screen.getByTestId('peer-kill-engage') as HTMLButtonElement).disabled).toBe(true);
        await userEvent.type(screen.getByLabelText(new RegExp(P.kill.reasonLabel)), 'Card under review');
        await userEvent.click(screen.getByTestId('peer-kill-engage'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/peers/peerpinned1/kill');
        expect(init).toMatchObject({ method: 'POST' });
        expect(JSON.parse(init.body)).toEqual({ reason: 'Card under review' });
    });

    it('lifts a kill in force with a reason, as a PATCH', async () => {
        renderDetail(detail({ kills: [{ id: 'k1', reason: 'Incident', engagedAt: '2026-10-19T07:00:00.000Z', liftedAt: null, liftReason: null }] }));
        await openTab(P.detail.tabKill);
        expect(screen.getByTestId('peer-kill-in-force').textContent).toContain('Incident');
        expect(screen.queryByTestId('peer-kill-engage')).toBeNull();
        await userEvent.type(screen.getByLabelText(new RegExp(P.kill.liftReasonLabel)), 'Resolved');
        await userEvent.click(screen.getByTestId('peer-kill-lift'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [, init] = fetchMock.mock.calls[0];
        expect(init).toMatchObject({ method: 'PATCH' });
        expect(JSON.parse(init.body)).toEqual({ liftReason: 'Resolved' });
    });

    it('is not offered without the kill key', async () => {
        renderDetail(detail({ kills: null }), { canKill: false });
        await openTab(P.detail.tabKill);
        expect(screen.getByTestId('peer-kill-permission-required').textContent).toContain(P.kill.permissionRequired);
        expect(screen.queryByTestId('peer-kill-engage')).toBeNull();
    });
});

describe('one peer: the inbound credential', () => {
    it('issues with one agent and its workflows, and shows the token once', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => ({
                token: 'iflp_secret_token_value',
                inflectIdentity: 'https://app.inflect.test/api/a2a/acme/agent-card.json',
                endpointPath: '/api/a2a/acme',
                inflectSigningPublicKey: KEY.publicKey,
            }),
        });
        renderDetail();
        await openTab(P.detail.tabCredential);
        expect(screen.getByTestId('peer-credential-none')).toBeTruthy();
        expect((screen.getByTestId('peer-credential-issue') as HTMLButtonElement).disabled).toBe(true);
        await userEvent.click(document.getElementById('peer-credential-agent')!);
        await userEvent.click(await screen.findByRole('option', { name: 'Reconciler' }));
        await userEvent.click(document.getElementById('peer-credential-workflows')!);
        await userEvent.click(await screen.findByRole('option', { name: 'Diagnostic' }));
        await userEvent.keyboard('{Escape}');
        await userEvent.click(screen.getByTestId('peer-credential-issue'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/peers/peerpinned1/inbound-credential');
        expect(JSON.parse(init.body)).toEqual({ receivingAgentId: 'agent-1', workflowKeys: ['diagnostic'] });
        expect((await screen.findByTestId('peer-credential-token')).textContent).toBe('iflp_secret_token_value');
        await userEvent.click(screen.getByTestId('peer-credential-token-done'));
        await waitFor(() => expect(screen.queryByTestId('peer-credential-token')).toBeNull());
        expect(mockRefresh).toHaveBeenCalled();
    });

    it('hands over the tenant\'s card URL as its identity, and says so when there is none', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => ({
                token: 'iflp_secret_token_value',
                inflectIdentity: 'https://app.inflect.test/api/a2a/acme/agent-card.json',
                endpointPath: '/api/a2a/acme',
                inflectSigningPublicKey: KEY.publicKey,
            }),
        });
        renderDetail();
        await openTab(P.detail.tabCredential);
        expect(screen.queryByTestId('peer-credential-origin-missing')).toBeNull();
        await userEvent.click(document.getElementById('peer-credential-agent')!);
        await userEvent.click(await screen.findByRole('option', { name: 'Reconciler' }));
        await userEvent.click(document.getElementById('peer-credential-workflows')!);
        await userEvent.click(await screen.findByRole('option', { name: 'Diagnostic' }));
        await userEvent.keyboard('{Escape}');
        await userEvent.click(screen.getByTestId('peer-credential-issue'));
        const panel = await screen.findByTestId('peer-credential-token-panel');
        expect(panel.textContent).toContain('https://app.inflect.test/api/a2a/acme/agent-card.json');
        expect(panel.textContent).toContain('/api/a2a/acme');
    });

    it('warns that every message is refused while the deployment has no public origin', async () => {
        renderDetail(detail({ credential: { ...detail().credential, handover: { ...detail().credential.handover, inflectIdentity: null } } }));
        await openTab(P.detail.tabCredential);
        expect(screen.getByTestId('peer-credential-origin-missing').textContent).toContain(P.credential.originMissing);
    });

    it('revokes the live credential after a confirmation with the canonical verb', async () => {
        renderDetail(
            detail({
                credential: {
                    ...detail().credential,
                    live: { id: 'c1', keyPrefix: 'iflp_abcd', receivingAgentId: 'agent-1', workflowKeys: ['diagnostic'], createdAt: '2026-10-19T08:00:00.000Z' },
                },
            }),
        );
        await openTab(P.detail.tabCredential);
        expect(screen.getByTestId('peer-credential-live').textContent).toContain('Reconciler');
        await userEvent.click(screen.getByTestId('peer-credential-revoke'));
        const dialog = await screen.findByRole('dialog');
        const confirm = within(dialog).getByRole('button', { name: P.credential.revoke });
        expect(confirm.textContent).toMatch(/^Revoke/);
        await userEvent.click(confirm);
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith('/api/t/acme/admin/agents/peers/peerpinned1/inbound-credential', { method: 'DELETE' }),
        );
    });

    it('offers neither issue nor revoke without the register key', async () => {
        renderDetail(detail(), { canManage: false });
        await openTab(P.detail.tabCredential);
        expect(screen.queryByTestId('peer-credential-issue')).toBeNull();
        expect(screen.getByText(P.credential.readOnly)).toBeTruthy();
    });
});

describe('one peer: overview and messages', () => {
    it('saves the quota as a number, as a PATCH on the peer', async () => {
        renderDetail();
        // Unchanged, there is nothing to save.
        expect((screen.getByTestId('peer-quota-save') as HTMLButtonElement).disabled).toBe(true);
        await userEvent.click(within(screen.getByTestId('peer-quota')).getByRole('button', { name: 'Increase' }));
        await userEvent.click(screen.getByTestId('peer-quota-save'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/agents/peers/peerpinned1');
        expect(init).toMatchObject({ method: 'PATCH' });
        expect(JSON.parse(init.body)).toEqual({ inboundMessagesPerHour: 61 });
    });

    it('says plainly when the card last read no longer matches the pin', () => {
        renderDetail(detail({ peer: { ...detail().peer, observedCardHash: HASH_B } }));
        expect(screen.getByTestId('peer-card-changed').textContent).toContain(P.detail.cardChangedNotice);
    });

    it('shows, per message, whether its receipt verifies', async () => {
        renderDetail();
        await openTab(P.detail.tabMessages);
        expect(screen.getByTestId('peer-messages-table')).toBeTruthy();
        expect(screen.getByTestId('peer-message-verifies-m1').textContent).toBe(P.messages.verifiesYes);
        expect(screen.getByTestId('peer-message-verifies-m2').textContent).toBe(P.messages.verifiesNo);
        expect(screen.getByTestId('peer-message-verifies-m3').textContent).toBe(P.messages.verifiesUnknown);
    });
});
