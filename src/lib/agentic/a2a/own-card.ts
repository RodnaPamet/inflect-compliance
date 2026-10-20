/**
 * INFLECT'S OWN A2A AGENT CARD, one per tenant (#3742; threat-model R19).
 *
 * A peer pins a card before it exchanges a single message (`peer-agent-card.ts`,
 * pinning rule 1). Until this module, Inflect pinned its peers' cards and
 * published none of its own: an operator handed each peer Inflect's endpoint,
 * its identity and its public key out of band. This builds, signs and verifies
 * the card that replaces that hand-over.
 *
 * ## One card per tenant, and it is the tenant's identity (owner decisions, 2026-10-20)
 *
 * The card lives at `<origin>/api/a2a/<tenantSlug>/agent-card.json`, and that
 * URL IS the tenant's A2A identity: the sender of every receipt the tenant
 * signs, and the recipient every peer must address. Inflect names a peer by
 * its card URL, so naming itself the same way is what lets one Inflect tenant
 * pin another. The identity it replaces, `inflect:a2a/<tenantId>/<peerId>`, was
 * per pair: each side's card URL would have needed the peer id the other side
 * assigns, which exists only once that side has registered this one, by that
 * very URL.
 *
 * The card names a per-tenant endpoint, `<origin>/api/a2a/<tenantSlug>`, where
 * the peer is found from its own credential.
 *
 * ## What the card carries, and what it never does
 *
 * Exactly the members `CARD_MEMBERS` lists. The pinning fields are:
 * - the endpoint and how it authenticates;
 * - the identity;
 * - the receipt format;
 * - the public key the tenant signs with now, and, for
 *   `A2A_PREVIOUS_KEY_GRACE_MS` after a rotation, the one it signed with
 *   before.
 *
 * The card has no agent list: `skills` is always empty. It also has no tenant
 * name, no tool name and no workflow name (R19). The tenant's slug is in it
 * because it is in the URL a peer was given. A test asserts the member set over
 * the whole document.
 *
 * ## The signature
 *
 * Ed25519 by the key in force, over a domain-separated canonical form of every
 * other member. Signing is deterministic, so the card a peer fetches twice is
 * the same bytes, and its pin holds until a key changes. A rotation changes the
 * card, and so does the end of the grace period: each is a change the PEER
 * re-approves, by the rule that a changed card refuses traffic until a person
 * approves it (`docs/a2a-threat-model.md`, pinning rule 4).
 *
 * This module is PURE: no I/O, no Prisma, no environment.
 */
import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

import { canonicalJson } from '@/lib/canonical-json';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import { ed25519PublicKeyFromMaterial } from '@/lib/mcp/receipt-verification';

import { A2A_RECEIPT_VERSION } from './receipt';

/** The card's own format, and the domain its signature is made over. */
export const INFLECT_AGENT_CARD_VERSION = 'inflect-a2a-card/1';

/**
 * How long the card names the previous key after a rotation. A peer that pinned
 * the card before the rotation verifies, during this window, the answers to
 * tasks it sent under the old key. After it, the card names the new key alone.
 * A source constant: changing it is a reviewed diff.
 */
export const A2A_PREVIOUS_KEY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** The path under the deployment's origin. The card URL is the tenant's identity. */
export function inflectA2aCardPath(tenantSlug: string): string {
    return `/api/a2a/${tenantSlug}/agent-card.json`;
}

/** Where a peer sends a task. The peer is found from its own credential. */
export function inflectA2aEndpointPath(tenantSlug: string): string {
    return `/api/a2a/${tenantSlug}`;
}

/** The tenant's A2A identity: its card URL. `origin` is `inflectA2aOrigin()`. */
export function inflectA2aIdentity(origin: string, tenantSlug: string): string {
    return `${origin}${inflectA2aCardPath(tenantSlug)}`;
}

export interface CardSigningKey {
    /** The raw 32-byte Ed25519 public key, hex. */
    readonly publicKeyHex: string;
    /** SPKI SHA-256, hex: the key id every receipt records. */
    readonly fingerprint: string;
}

export interface RetiredCardKey extends CardSigningKey {
    readonly retiredAt: Date;
}

export interface InflectAgentCardInput {
    readonly origin: string;
    readonly tenantSlug: string;
    readonly current: CardSigningKey;
    /** The most recently retired key, if any. Named only while within the grace period. */
    readonly previous: RetiredCardKey | null;
    readonly now: Date;
}

/** The card's members, all of them. Anything else is a defect. */
export const CARD_MEMBERS = [
    'name',
    'description',
    'url',
    'version',
    'protocolVersion',
    'preferredTransport',
    'capabilities',
    'defaultInputModes',
    'defaultOutputModes',
    'skills',
    'securitySchemes',
    'security',
    'x-inflect',
    'x-inflect-signature',
] as const;

const SIGNATURE_MEMBER = 'x-inflect-signature';

export interface InflectCardKey {
    readonly publicKey: string;
    readonly fingerprint: string;
    readonly status: 'CURRENT' | 'PREVIOUS';
    /** Set on the previous key: when it stops being named. */
    readonly validUntil?: string;
}

export type UnsignedInflectAgentCard = {
    readonly name: string;
    readonly description: string;
    readonly url: string;
    readonly version: string;
    readonly protocolVersion: string;
    readonly preferredTransport: 'JSONRPC';
    readonly capabilities: { readonly streaming: false; readonly pushNotifications: false };
    readonly defaultInputModes: readonly string[];
    readonly defaultOutputModes: readonly string[];
    readonly skills: readonly never[];
    readonly securitySchemes: { readonly peerCredential: { readonly type: 'http'; readonly scheme: 'bearer' } };
    readonly security: readonly [{ readonly peerCredential: readonly [] }];
    readonly 'x-inflect': {
        readonly format: typeof INFLECT_AGENT_CARD_VERSION;
        readonly identity: string;
        readonly receipt: typeof A2A_RECEIPT_VERSION;
        readonly signingKeys: readonly InflectCardKey[];
    };
};

export type InflectAgentCard = UnsignedInflectAgentCard & {
    readonly 'x-inflect-signature': {
        readonly alg: 'Ed25519';
        readonly keyFingerprint: string;
        /** Ed25519, hex (64 bytes). */
        readonly value: string;
    };
};

/** Whether a retired key is still within the grace period at `now`. */
export function previousKeyInGrace(retiredAt: Date, now: Date): boolean {
    const age = now.getTime() - retiredAt.getTime();
    return age >= 0 && age < A2A_PREVIOUS_KEY_GRACE_MS;
}

/** The card before it is signed. The same input always gives the same card. */
export function buildInflectAgentCard(input: InflectAgentCardInput): UnsignedInflectAgentCard {
    const identity = inflectA2aIdentity(input.origin, input.tenantSlug);
    const keys: InflectCardKey[] = [
        { publicKey: input.current.publicKeyHex, fingerprint: input.current.fingerprint, status: 'CURRENT' },
    ];
    if (input.previous && previousKeyInGrace(input.previous.retiredAt, input.now)) {
        keys.push({
            publicKey: input.previous.publicKeyHex,
            fingerprint: input.previous.fingerprint,
            status: 'PREVIOUS',
            validUntil: new Date(input.previous.retiredAt.getTime() + A2A_PREVIOUS_KEY_GRACE_MS).toISOString(),
        });
    }
    return {
        name: 'Inflect',
        description:
            'The A2A endpoint of one Inflect workspace. A task is accepted only from a peer this workspace has ' +
            'registered and pinned, presenting its own credential and signing every message.',
        url: `${input.origin}${inflectA2aEndpointPath(input.tenantSlug)}`,
        version: INFLECT_AGENT_CARD_VERSION,
        protocolVersion: '0.3.0',
        preferredTransport: 'JSONRPC',
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ['text/plain', 'application/json'],
        defaultOutputModes: ['application/json'],
        skills: [],
        securitySchemes: { peerCredential: { type: 'http', scheme: 'bearer' } },
        security: [{ peerCredential: [] }],
        'x-inflect': {
            format: INFLECT_AGENT_CARD_VERSION,
            identity,
            receipt: A2A_RECEIPT_VERSION,
            signingKeys: keys,
        },
    };
}

/** The bytes the signature covers: the version, a newline, the canonical card without its signature. */
function signedBytes(unsigned: Record<string, unknown>): Buffer {
    return Buffer.from(`${INFLECT_AGENT_CARD_VERSION}\n${canonicalJson(unsigned)}`, 'utf8');
}

/** Sign with the key in force. `key.fingerprint` must be the CURRENT key the card names. */
export function signInflectAgentCard(
    card: UnsignedInflectAgentCard,
    key: { readonly privateKey: KeyObject; readonly fingerprint: string },
): InflectAgentCard {
    const current = card['x-inflect'].signingKeys.find((k) => k.status === 'CURRENT');
    if (!current || current.fingerprint !== key.fingerprint) {
        throw new Error('An Inflect agent card is signed only by the key it names as current');
    }
    const value = cryptoSign(null, signedBytes(card as unknown as Record<string, unknown>), key.privateKey).toString(
        'hex',
    );
    return { ...card, [SIGNATURE_MEMBER]: { alg: 'Ed25519', keyFingerprint: key.fingerprint, value } };
}

export type InflectCardVerdict =
    | { readonly ok: true }
    | {
          readonly ok: false;
          readonly reason: 'MALFORMED' | 'UNEXPECTED_MEMBER' | 'KEY_INVALID' | 'KEY_NOT_NAMED' | 'SIGNATURE_INVALID';
      };

/**
 * Verify a card against the public key the verifier trusts for that tenant.
 * The key must be the card's CURRENT key, and must hash to the fingerprint the
 * signature names, so a card cannot vouch for itself with a key it chose.
 */
export function verifyInflectAgentCard(card: unknown, trustedPublicKey: string): InflectCardVerdict {
    if (typeof card !== 'object' || card === null || Array.isArray(card)) return { ok: false, reason: 'MALFORMED' };
    const record = card as Record<string, unknown>;
    if (Object.keys(record).some((k) => !(CARD_MEMBERS as readonly string[]).includes(k))) {
        return { ok: false, reason: 'UNEXPECTED_MEMBER' };
    }
    const sig = record[SIGNATURE_MEMBER] as { alg?: unknown; keyFingerprint?: unknown; value?: unknown } | undefined;
    const inflect = record['x-inflect'] as { signingKeys?: unknown } | undefined;
    if (
        !sig ||
        sig.alg !== 'Ed25519' ||
        typeof sig.keyFingerprint !== 'string' ||
        typeof sig.value !== 'string' ||
        !/^[0-9a-f]{128}$/.test(sig.value) ||
        !inflect ||
        !Array.isArray(inflect.signingKeys)
    ) {
        return { ok: false, reason: 'MALFORMED' };
    }
    const key = ed25519PublicKeyFromMaterial(trustedPublicKey);
    if (!key) return { ok: false, reason: 'KEY_INVALID' };
    const fingerprint = harnessKeyFingerprint(trustedPublicKey);
    const current = (inflect.signingKeys as Array<Record<string, unknown>>).find((k) => k?.status === 'CURRENT');
    if (!current || current.fingerprint !== fingerprint || sig.keyFingerprint !== fingerprint) {
        return { ok: false, reason: 'KEY_NOT_NAMED' };
    }
    const unsigned = { ...record };
    delete unsigned[SIGNATURE_MEMBER];
    let valid = false;
    try {
        valid = cryptoVerify(null, signedBytes(unsigned), key, Buffer.from(sig.value, 'hex'));
    } catch {
        valid = false;
    }
    return valid ? { ok: true } : { ok: false, reason: 'SIGNATURE_INVALID' };
}

/**
 * The deployment's public https origin, normalised, or `null` when `configured`
 * is not one. No request-derived fallback: the identity is signed, so it must
 * be the address peers reach, never a proxy's bind address.
 */
export function a2aOriginFrom(configured: string | undefined | null): string | null {
    const value = configured?.trim();
    if (!value) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
}
