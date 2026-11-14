/**
 * The scheduled ASI07 check (`checkA2aIntegrity`, #5305 item 25, owner
 * decision 2026-11-14): approved peers whose live card moved, a signing key
 * past its rotation age, stored receipts that no longer verify, and peers left
 * unpinned.
 *
 * Driven against an in-memory stand-in for the runner's transaction, with the
 * live card supplied by the injected reader, so every branch is reached
 * without a network. The real runner, database and two tenants are
 * `tests/integration/agentic-a2a-integrity.test.ts`.
 *
 * The property held throughout: nothing reads as PASS that the check did not
 * examine. No peers is vacuous; an unreadable card or a receipt whose key is
 * not held is INCONCLUSIVE; any breach is FAIL.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import {
    A2A_SIGNING_KEY_MAX_AGE_DAYS,
    A2A_UNPINNED_GRACE_DAYS,
    AGENTIC_CONTROL_EXEMPTIONS,
    AGENTIC_CHECKS,
    checkA2aIntegrity,
    parseAgenticCheckConfig,
    type A2aCardReader,
} from '@/app-layer/services/agent-control-tests';
import { a2aBodyDigest, canonicalStatement, rawEd25519PublicKeyHex, signA2aReceipt } from '@/lib/agentic/a2a/receipt';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import type { PrismaTx } from '@/lib/db-context';

const NOW = new Date('2026-11-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

const HASHES = { cardHash: 'c'.repeat(64), textHash: 't'.repeat(64), endpointHash: 'e'.repeat(64), otherHash: 'o'.repeat(64) };

interface Keypair {
    privateKey: KeyObject;
    publicHex: string;
    fingerprint: string;
}

function keypair(): Keypair {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const publicHex = rawEd25519PublicKeyHex(Buffer.from(spki.subarray(spki.length - 32)).toString('hex'))!;
    const fingerprint = harnessKeyFingerprint(publicHex);
    if (!fingerprint) throw new Error('fixture key has no fingerprint');
    return { privateKey, publicHex, fingerprint };
}

interface PeerRow {
    id: string;
    cardUrl: string;
    createdAt: Date;
    status: 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
    signingPublicKey: string;
    signingKeyFingerprint: string;
    pinnedCardHash: string | null;
    pinnedTextHash: string | null;
    pinnedEndpointHash: string | null;
    pinnedOtherHash: string | null;
    pinRevision: number;
}

interface MessageRow {
    id: string;
    peerId: string;
    direction: 'INBOUND' | 'OUTBOUND';
    receiptJson: string;
    signature: string;
    signerKeyFingerprint: string;
    body: string;
    createdAt: Date;
}

interface KeyRow {
    id: string;
    fingerprint: string;
    publicKey: string;
    createdAt: Date;
    retiredAt: Date | null;
}

function peer(id: string, over: Partial<PeerRow> = {}, signer: Keypair = keypair()): PeerRow {
    return {
        id,
        cardUrl: `https://partner.example/${id}/agent-card.json`,
        createdAt: daysAgo(30),
        status: 'ACTIVE',
        signingPublicKey: signer.publicHex,
        signingKeyFingerprint: signer.fingerprint,
        pinnedCardHash: HASHES.cardHash,
        pinnedTextHash: HASHES.textHash,
        pinnedEndpointHash: HASHES.endpointHash,
        pinnedOtherHash: HASHES.otherHash,
        pinRevision: 1,
        ...over,
    };
}

const UNPINNED = {
    pinnedCardHash: null,
    pinnedTextHash: null,
    pinnedEndpointHash: null,
    pinnedOtherHash: null,
    pinRevision: 0,
} as const;

let seq = 0;
function receipt(
    peerId: string,
    direction: 'INBOUND' | 'OUTBOUND',
    signer: Keypair,
    over: Partial<MessageRow> = {},
): MessageRow {
    seq += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id: seq, method: 'message/send' });
    const signed = signA2aReceipt(
        {
            v: 'inflect-a2a-receipt/1',
            kind: 'TASK',
            messageId: `m-${seq}`,
            relatesTo: null,
            method: 'message/send',
            sender: 'https://a.example',
            recipient: 'https://b.example',
            issuedAt: NOW.toISOString(),
            bodyDigest: a2aBodyDigest(body),
        },
        signer.privateKey,
    );
    return {
        id: `msg-${seq}`,
        peerId,
        direction,
        receiptJson: canonicalStatement(signed.statement),
        signature: signed.signature,
        signerKeyFingerprint: signer.fingerprint,
        body,
        createdAt: new Date(NOW.getTime() - seq * 1000),
        ...over,
    };
}

/** The three delegates the check reads, over plain arrays. */
function fakeDb(state: { peers?: PeerRow[]; messages?: MessageRow[]; keys?: KeyRow[] }): PrismaTx {
    const peers = state.peers ?? [];
    const messages = state.messages ?? [];
    const keys = state.keys ?? [];
    const db = {
        peerAgent: {
            findMany: jest.fn(async (args: { where: { status?: string; id?: { in: string[] } }; take: number }) => {
                const rows = args.where.id
                    ? peers.filter((p) => args.where.id!.in.includes(p.id))
                    : peers.filter((p) => p.status === args.where.status).sort((a, b) => a.id.localeCompare(b.id));
                return rows.slice(0, args.take);
            }),
        },
        peerAgentMessage: {
            findMany: jest.fn(async (args: { take: number }) =>
                [...messages].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, args.take),
            ),
        },
        tenantA2aSigningKey: {
            findMany: jest.fn(async (args: { where: { fingerprint: { in: string[] } } }) =>
                keys.filter((k) => args.where.fingerprint.in.includes(k.fingerprint)),
            ),
            findFirst: jest.fn(async () =>
                keys.filter((k) => k.retiredAt === null).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null,
            ),
        },
    };
    return db as unknown as PrismaTx;
}

const serves =
    (byPeer: Record<string, typeof HASHES | 'UNREADABLE' | 'THROWS'>): A2aCardReader =>
    async ({ peerId }) => {
        const v = byPeer[peerId] ?? HASHES;
        if (v === 'THROWS') throw new Error('socket hang up');
        if (v === 'UNREADABLE') return { ok: false, reason: 'TIMEOUT' };
        return { ok: true, card: {} as never, hashes: v, fetchedAt: NOW };
    };

const ownKey = (k: Keypair, createdAt: Date, retiredAt: Date | null = null): KeyRow => ({
    id: `key-${k.fingerprint.slice(0, 6)}`,
    fingerprint: k.fingerprint,
    publicKey: k.publicHex,
    createdAt,
    retiredAt,
});

describe('the ASI07 exemption is gone and a check covers it', () => {
    it('no exemption names ASI07', () => {
        expect(Object.keys(AGENTIC_CONTROL_EXEMPTIONS)).not.toContain('ASI07');
    });

    it('AGENTIC_A2A_INTEGRITY covers ASI07', () => {
        expect(AGENTIC_CHECKS.AGENTIC_A2A_INTEGRITY.covers).toEqual(['ASI07']);
    });

    it('a plan config may set the key age within 30..1095 days, and nothing outside it', () => {
        expect(parseAgenticCheckConfig({ check: 'AGENTIC_A2A_INTEGRITY', signingKeyMaxAgeDays: 180 })).toMatchObject({
            signingKeyMaxAgeDays: 180,
        });
        expect(
            parseAgenticCheckConfig({ check: 'AGENTIC_A2A_INTEGRITY', signingKeyMaxAgeDays: 5 })?.signingKeyMaxAgeDays,
        ).toBeUndefined();
    });
});

describe('checkA2aIntegrity', () => {
    const tenantKey = keypair();
    const freshKey = ownKey(tenantKey, daysAgo(10));

    it('zero peers and zero receipts is vacuous, never a PASS', async () => {
        const out = await checkA2aIntegrity(fakeDb({ keys: [freshKey] }), 't1', NOW, { readCard: serves({}) });
        expect(out).toMatchObject({ verdict: 'INCONCLUSIVE', basis: 'NO_A2A_PEERS', vacuous: true, population: 0 });
    });

    it('a suspended peer alone is not a population', async () => {
        const out = await checkA2aIntegrity(fakeDb({ peers: [peer('p1', { status: 'SUSPENDED' })] }), 't1', NOW, {
            readCard: serves({}),
        });
        expect(out).toMatchObject({ verdict: 'INCONCLUSIVE', vacuous: true });
    });

    it('PASSES a pinned peer serving its pin, a fresh key and receipts that verify', async () => {
        const signer = keypair();
        const p1 = peer('p1', {}, signer);
        const out = await checkA2aIntegrity(
            fakeDb({
                peers: [p1],
                keys: [freshKey],
                messages: [receipt('p1', 'INBOUND', signer), receipt('p1', 'OUTBOUND', tenantKey)],
            }),
            't1',
            NOW,
            { readCard: serves({}) },
        );
        expect(out).toMatchObject({ verdict: 'PASS', basis: 'A2A_STATE_AS_APPROVED', breaches: 0, vacuous: false });
        // One peer, one key, two receipts.
        expect(out.population).toBe(4);
    });

    it('FAILS an approved peer whose live card moved, naming the components and never the text', async () => {
        const out = await checkA2aIntegrity(fakeDb({ peers: [peer('p1')], keys: [freshKey] }), 't1', NOW, {
            readCard: serves({ p1: { ...HASHES, cardHash: 'd'.repeat(64), endpointHash: 'f'.repeat(64) } }),
        });
        expect(out).toMatchObject({ verdict: 'FAIL', basis: 'A2A_STATE_DRIFTED', breaches: 1 });
        expect(out.facts).toContain('peer=p1 code=CARD_MOVED_SINCE_PIN revision=1 moved=ENDPOINT');
    });

    it('is INCONCLUSIVE, not PASS, when a pinned peer\'s card cannot be read', async () => {
        const out = await checkA2aIntegrity(fakeDb({ peers: [peer('p1'), peer('p2')], keys: [freshKey] }), 't1', NOW, {
            readCard: serves({ p1: 'UNREADABLE', p2: 'THROWS' }),
        });
        expect(out).toMatchObject({ verdict: 'INCONCLUSIVE', basis: 'A2A_STATE_UNVERIFIABLE', vacuous: false });
        expect(out.facts).toContain('peer=p1 code=PEER_CARD_UNREADABLE reason=TIMEOUT');
        expect(out.facts).toContain('peer=p2 code=PEER_CARD_UNREADABLE reason=READ_THREW');
    });

    it('a breach elsewhere still FAILS when a card is also unreadable', async () => {
        const out = await checkA2aIntegrity(
            fakeDb({ peers: [peer('p1'), peer('p2', { ...UNPINNED, createdAt: daysAgo(30) })], keys: [freshKey] }),
            't1',
            NOW,
            { readCard: serves({ p1: 'UNREADABLE' }) },
        );
        expect(out.verdict).toBe('FAIL');
    });

    it('an unpinned peer is awaited inside the grace and a breach after it', async () => {
        const young = peer('p1', { ...UNPINNED, createdAt: daysAgo(A2A_UNPINNED_GRACE_DAYS - 1) });
        const awaited = await checkA2aIntegrity(fakeDb({ peers: [young], keys: [freshKey] }), 't1', NOW, {
            readCard: serves({}),
        });
        expect(awaited).toMatchObject({ verdict: 'PASS', breaches: 0 });
        expect(awaited.facts).toContain('awaitingPin=1');

        const left = peer('p1', { ...UNPINNED, createdAt: daysAgo(A2A_UNPINNED_GRACE_DAYS + 3) });
        const out = await checkA2aIntegrity(fakeDb({ peers: [left], keys: [freshKey] }), 't1', NOW, {
            readCard: serves({}),
        });
        expect(out).toMatchObject({ verdict: 'FAIL', breaches: 1 });
        expect(out.facts).toContain(`peer=p1 code=PEER_LEFT_UNPINNED ageDays=${A2A_UNPINNED_GRACE_DAYS + 3}`);
    });

    it('FAILS a signing key in force past the rotation age, and honours a plan\'s own age', async () => {
        const old = ownKey(tenantKey, daysAgo(A2A_SIGNING_KEY_MAX_AGE_DAYS + 1));
        const out = await checkA2aIntegrity(fakeDb({ peers: [peer('p1')], keys: [old] }), 't1', NOW, {
            readCard: serves({}),
        });
        expect(out).toMatchObject({ verdict: 'FAIL', breaches: 1 });
        expect(out.facts.some((f) => f.includes('code=SIGNING_KEY_PAST_ROTATION_AGE'))).toBe(true);

        const tighter = await checkA2aIntegrity(fakeDb({ peers: [peer('p1')], keys: [freshKey] }), 't1', NOW, {
            readCard: serves({}),
            signingKeyMaxAgeDays: 5,
        });
        expect(tighter.verdict).toBe('FAIL');
    });

    it('a retired key is never judged by its age', async () => {
        const retired = ownKey(keypair(), daysAgo(900), daysAgo(400));
        const out = await checkA2aIntegrity(fakeDb({ peers: [peer('p1')], keys: [retired, freshKey] }), 't1', NOW, {
            readCard: serves({}),
        });
        expect(out.verdict).toBe('PASS');
    });

    it('FAILS a stored receipt whose body no longer matches its signed digest', async () => {
        const signer = keypair();
        const tampered = receipt('p1', 'INBOUND', signer, { body: '{"tampered":true}' });
        const out = await checkA2aIntegrity(
            fakeDb({ peers: [peer('p1', {}, signer)], keys: [freshKey], messages: [tampered] }),
            't1',
            NOW,
            { readCard: serves({}) },
        );
        expect(out).toMatchObject({ verdict: 'FAIL', breaches: 1 });
        expect(out.facts).toContain(`receipt=${tampered.id} peer=p1 direction=INBOUND code=RECEIPT_DOES_NOT_VERIFY`);
    });

    it('a receipt signed by a retired tenant key still verifies', async () => {
        const retiredKey = keypair();
        const out = await checkA2aIntegrity(
            fakeDb({
                peers: [peer('p1')],
                keys: [ownKey(retiredKey, daysAgo(200), daysAgo(20)), freshKey],
                messages: [receipt('p1', 'OUTBOUND', retiredKey)],
            }),
            't1',
            NOW,
            { readCard: serves({}) },
        );
        expect(out.verdict).toBe('PASS');
    });

    it('is INCONCLUSIVE when a receipt names a key this tenant does not hold', async () => {
        const stranger = keypair();
        const out = await checkA2aIntegrity(
            fakeDb({ peers: [peer('p1')], keys: [freshKey], messages: [receipt('p1', 'INBOUND', stranger)] }),
            't1',
            NOW,
            { readCard: serves({}) },
        );
        expect(out).toMatchObject({ verdict: 'INCONCLUSIVE', basis: 'A2A_STATE_UNVERIFIABLE' });
        expect(out.facts.some((f) => f.endsWith('code=RECEIPT_KEY_NOT_HELD'))).toBe(true);
    });

    it('re-verifies receipts from a peer since retired, which is not a peer population', async () => {
        const signer = keypair();
        const out = await checkA2aIntegrity(
            fakeDb({
                peers: [peer('p1', { status: 'RETIRED' }, signer)],
                messages: [receipt('p1', 'INBOUND', signer)],
            }),
            't1',
            NOW,
            { readCard: serves({}) },
        );
        expect(out).toMatchObject({ verdict: 'PASS', vacuous: false, population: 1 });
    });
});
