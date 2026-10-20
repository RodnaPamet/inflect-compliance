/**
 * Inflect's own A2A agent card (#3742; threat-model R19), the pure half: what it
 * names, that it verifies against the tenant's key and fails when tampered,
 * that a rotation's previous key is named only for its grace period, and that
 * the card names nothing beyond the pinning fields — asserted over the WHOLE
 * document, not a sample of it.
 */
import { a2aSigningKeyFromSeed, mintA2aSigningSeed } from '@/lib/agentic/a2a/signing-key';
import {
    A2A_PREVIOUS_KEY_GRACE_MS,
    CARD_MEMBERS,
    a2aOriginFrom,
    buildInflectAgentCard,
    inflectA2aIdentity,
    signInflectAgentCard,
    verifyInflectAgentCard,
    type InflectAgentCard,
} from '@/lib/agentic/a2a/own-card';

function key() {
    const k = a2aSigningKeyFromSeed(mintA2aSigningSeed());
    if (!k) throw new Error('no key');
    return k;
}

const ORIGIN = 'https://app.inflect.test';
const NOW = new Date('2026-10-20T12:00:00Z');

function cardFor(slug: string, current = key(), previous: { k: ReturnType<typeof key>; retiredAt: Date } | null = null) {
    const unsigned = buildInflectAgentCard({
        origin: ORIGIN,
        tenantSlug: slug,
        current: { publicKeyHex: current.publicKeyHex, fingerprint: current.fingerprint },
        previous: previous
            ? { publicKeyHex: previous.k.publicKeyHex, fingerprint: previous.k.fingerprint, retiredAt: previous.retiredAt }
            : null,
        now: NOW,
    });
    return { card: signInflectAgentCard(unsigned, current), current };
}

/** Every string anywhere in a JSON value, keys included. */
function everyString(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => everyString(v, out));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            out.push(k);
            everyString(v, out);
        }
    }
    return out;
}

describe('the card names the endpoint, the identity and the key in force', () => {
    it('at the per-tenant addresses', () => {
        const { card, current } = cardFor('acme');
        expect(card.url).toBe(`${ORIGIN}/api/a2a/acme`);
        expect(card['x-inflect'].identity).toBe(`${ORIGIN}/api/a2a/acme/agent-card.json`);
        expect(card['x-inflect'].identity).toBe(inflectA2aIdentity(ORIGIN, 'acme'));
        expect(card['x-inflect'].signingKeys).toEqual([
            { publicKey: current.publicKeyHex, fingerprint: current.fingerprint, status: 'CURRENT' },
        ]);
        expect(card['x-inflect-signature']).toMatchObject({ alg: 'Ed25519', keyFingerprint: current.fingerprint });
    });

    it('is the same bytes each time it is built, so a peer\'s pin holds until a key changes', () => {
        const k = key();
        expect(JSON.stringify(cardFor('acme', k).card)).toBe(JSON.stringify(cardFor('acme', k).card));
    });
});

describe('the signature', () => {
    it('verifies against the tenant\'s key', () => {
        const { card, current } = cardFor('acme');
        expect(verifyInflectAgentCard(card, current.publicKeyHex)).toEqual({ ok: true });
        // Survives the trip a peer makes: serialised, fetched, parsed.
        expect(verifyInflectAgentCard(JSON.parse(JSON.stringify(card)), current.publicKeyHex)).toEqual({ ok: true });
    });

    /** The card as a peer holds it after `JSON.parse`: every member writable. */
    type Parsed = {
        url: string;
        description: string;
        'x-inflect': { identity: string; signingKeys: { publicKey: string }[] };
        'x-inflect-signature': { value: string };
    };
    it.each<[string, (c: Parsed) => void]>([
        ['the endpoint', (c) => { c.url = 'https://evil.example/api/a2a/acme'; }],
        ['the identity', (c) => { c['x-inflect'].identity = 'https://evil.example/card'; }],
        ['a key', (c) => { c['x-inflect'].signingKeys[0].publicKey = '00'.repeat(32); }],
        ['the description', (c) => { c.description += ' '; }],
        ['the signature', (c) => { c['x-inflect-signature'].value = 'ab'.repeat(64); }],
    ])('fails when %s is tampered with', (_label, tamper) => {
        const { card, current } = cardFor('acme');
        const copy = JSON.parse(JSON.stringify(card));
        tamper(copy);
        expect(verifyInflectAgentCard(copy, current.publicKeyHex).ok).toBe(false);
    });

    it('fails against any other key, and cannot vouch for itself with one it names', () => {
        const { card } = cardFor('acme');
        const other = key();
        expect(verifyInflectAgentCard(card, other.publicKeyHex)).toEqual({ ok: false, reason: 'KEY_NOT_NAMED' });
        // A card re-signed by an attacker's key, naming that key: the verifier
        // is not asked which key the card names, it is told which key it trusts.
        const forged = cardFor('acme', other).card;
        expect(verifyInflectAgentCard(forged, cardFor('acme').current.publicKeyHex).ok).toBe(false);
    });

    it('a card is signed only by the key it names as current', () => {
        const k = key();
        const unsigned = buildInflectAgentCard({
            origin: ORIGIN,
            tenantSlug: 'acme',
            current: { publicKeyHex: k.publicKeyHex, fingerprint: k.fingerprint },
            previous: null,
            now: NOW,
        });
        expect(() => signInflectAgentCard(unsigned, key())).toThrow(/only by the key it names as current/);
    });

    it('refuses a member it does not know, even one that leaves the signature intact', () => {
        const { card, current } = cardFor('acme');
        const extended = { ...card, agents: ['a'] } as unknown as InflectAgentCard;
        expect(verifyInflectAgentCard(extended, current.publicKeyHex)).toEqual({ ok: false, reason: 'UNEXPECTED_MEMBER' });
        expect(verifyInflectAgentCard('not a card', current.publicKeyHex)).toEqual({ ok: false, reason: 'MALFORMED' });
    });
});

describe('a rotation', () => {
    const retiredFor = (ms: number) => new Date(NOW.getTime() - ms);

    it('names the previous key during its grace period, with when it stops', () => {
        const old = key();
        const retiredAt = retiredFor(60_000);
        const { card, current } = cardFor('acme', key(), { k: old, retiredAt });
        expect(card['x-inflect'].signingKeys).toEqual([
            { publicKey: current.publicKeyHex, fingerprint: current.fingerprint, status: 'CURRENT' },
            {
                publicKey: old.publicKeyHex,
                fingerprint: old.fingerprint,
                status: 'PREVIOUS',
                validUntil: new Date(retiredAt.getTime() + A2A_PREVIOUS_KEY_GRACE_MS).toISOString(),
            },
        ]);
        // Signed by the new key, and only the new key.
        expect(verifyInflectAgentCard(card, current.publicKeyHex)).toEqual({ ok: true });
        expect(verifyInflectAgentCard(card, old.publicKeyHex).ok).toBe(false);
    });

    it('names it no longer once the grace period is over', () => {
        const atEdge = cardFor('acme', key(), { k: key(), retiredAt: retiredFor(A2A_PREVIOUS_KEY_GRACE_MS) }).card;
        expect(atEdge['x-inflect'].signingKeys.map((k) => k.status)).toEqual(['CURRENT']);
        const justInside = cardFor('acme', key(), { k: key(), retiredAt: retiredFor(A2A_PREVIOUS_KEY_GRACE_MS - 1) }).card;
        expect(justInside['x-inflect'].signingKeys.map((k) => k.status)).toEqual(['CURRENT', 'PREVIOUS']);
    });

    it('does not name a key "retired" in the future', () => {
        const card = cardFor('acme', key(), { k: key(), retiredAt: new Date(NOW.getTime() + 1000) }).card;
        expect(card['x-inflect'].signingKeys.map((k) => k.status)).toEqual(['CURRENT']);
    });
});

describe('the card names nothing beyond the pinning fields', () => {
    const { card } = cardFor('acme', key(), { k: key(), retiredAt: new Date(NOW.getTime() - 1000) });

    it('carries exactly the declared members', () => {
        expect(Object.keys(card).sort()).toEqual([...CARD_MEMBERS].sort());
    });

    it('carries no agent list', () => {
        expect(card.skills).toEqual([]);
    });

    it('every string in the whole document is a fixed word, the tenant\'s own addresses, or key material', () => {
        const keyMaterial = new Set(
            card['x-inflect'].signingKeys.flatMap((k) => [k.publicKey, k.fingerprint, k.validUntil ?? '']),
        );
        keyMaterial.add(card['x-inflect-signature'].value);
        const addresses = new Set([card.url, card['x-inflect'].identity]);
        const FIXED = new Set<string>([
            ...CARD_MEMBERS,
            'Inflect',
            card.description,
            'inflect-a2a-card/1',
            'inflect-a2a-receipt/1',
            '0.3.0',
            'JSONRPC',
            'streaming',
            'pushNotifications',
            'text/plain',
            'application/json',
            'peerCredential',
            'type',
            'http',
            'scheme',
            'bearer',
            'format',
            'identity',
            'receipt',
            'signingKeys',
            'publicKey',
            'fingerprint',
            'status',
            'validUntil',
            'CURRENT',
            'PREVIOUS',
            'alg',
            'Ed25519',
            'keyFingerprint',
            'value',
        ]);
        const unexplained = everyString(card).filter((s) => !FIXED.has(s) && !keyMaterial.has(s) && !addresses.has(s));
        expect(unexplained).toEqual([]);
        // The description is a fixed sentence: it names no tenant.
        expect(card.description).not.toMatch(/acme/i);
    });

    it('two tenants\' cards are distinct, and neither names the other', () => {
        const one = JSON.stringify(cardFor('acme').card);
        const two = JSON.stringify(cardFor('globex').card);
        expect(one).not.toBe(two);
        expect(one).not.toContain('globex');
        expect(two).not.toContain('acme');
    });
});

describe('the origin the identity is built on', () => {
    it.each([
        ['https://app.inflect.bg', 'https://app.inflect.bg'],
        ['https://app.inflect.bg/', 'https://app.inflect.bg'],
        ['  https://app.inflect.bg  ', 'https://app.inflect.bg'],
        ['https://app.inflect.bg:8443', 'https://app.inflect.bg:8443'],
    ])('accepts the bare https origin %s', (value, expected) => {
        expect(a2aOriginFrom(value)).toBe(expected);
    });

    it.each([
        [undefined],
        [''],
        ['http://app.inflect.bg'],
        ['https://app.inflect.bg/sub'],
        ['https://user:pw@app.inflect.bg'],
        ['https://app.inflect.bg/?x=1'],
        ['https://app.inflect.bg/#frag'],
        ['not a url'],
    ])('refuses %p, which would make the signed identity something peers cannot reach', (value) => {
        expect(a2aOriginFrom(value)).toBeNull();
    });
});
