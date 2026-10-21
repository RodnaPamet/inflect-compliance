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
 * The PEER card has no agent list: its `skills` is always empty, and typed
 * `readonly never[]` so it cannot acquire one. It also has no tenant name, no
 * tool name and no workflow name (R19). The tenant's slug is in it because it
 * is in the URL a peer was given. A test asserts the member set over the whole
 * document.
 *
 * ## Two variants, one member set (#3862)
 *
 * `buildInflectHostConsumerCard` builds a second variant for HOST CONSUMERS —
 * the principal admitted by `a2a-host-consumer-admission.ts`. It carries the
 * same `CARD_MEMBERS`, so `verifyInflectAgentCard` verifies either, and differs
 * in exactly two values: `skills` lists the advertised workflows, and
 * `securitySchemes` names the OAuth2 client-credentials flow instead of a
 * peer's bearer credential.
 *
 * **The host variant's skills do not depend on the tenant.** They are the
 * workflows that carry reviewed public copy, so the list is identical for every
 * tenant and discloses nothing tenant-specific. Which workflows a given
 * consumer may actually call is NOT on the card — it is `HostConsumer.workflowKeys`,
 * enforced per request from the row by `startInboundRun`. A card that published
 * the grants would have had to publish the union across a tenant's consumers,
 * telling each what the others may call. The owner decision is on #3862.
 *
 * A consequence to keep in mind before "fixing" it: the card advertises more
 * than most callers may invoke, so `WORKFLOW_NOT_ALLOWED` is an EXPECTED answer
 * to a well-formed request, not a misconfiguration.
 *
 * Which path serves which variant is decided in `a2a-agent-card.ts`.
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
// Type-only, so this module stays free of the workflow engine at runtime and
// the published skill shape has ONE definition rather than two that can drift.
import type { A2aPublicSkill } from '@/lib/agentic/workflow-types';

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

/**
 * WHERE A HOST LOOKS FOR THE CARD, relative to the per-tenant base (#3862).
 *
 * Two paths, because the protocol renamed the file and SAP's toolkit did not
 * follow. `agent.json` is the pre-0.3 name and the one SAP's Joule toolkit
 * composes — "destination base URL" + `/.well-known/agent.json`, confirmed from
 * `skills/joule-a2a-agent/SKILL.md:311` ("must be served at") at the toolkit's
 * 2026-04-21 head. `agent-card.json` is the v0.3/v1.0 name. A host reading
 * either spec, or SAP's toolkit, finds the card.
 *
 * Both serve the SAME bytes. They are not alternatives to
 * `inflectA2aCardPath` — that path is the tenant's signed IDENTITY and still
 * serves the peer card.
 */
export const HOST_CONSUMER_CARD_FILENAMES = ['agent.json', 'agent-card.json'] as const;

/** The well-known paths the host card is served at, in a fixed order. */
export function inflectA2aHostCardPaths(tenantSlug: string): readonly string[] {
    return HOST_CONSUMER_CARD_FILENAMES.map((f) => `/api/a2a/${tenantSlug}/.well-known/${f}`);
}

/** Where a host consumer exchanges its client credentials for a token (J1). */
export function inflectA2aTokenPath(tenantSlug: string): string {
    return `/api/a2a/${tenantSlug}/token`;
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

/** The signature member, the one thing added by signing. */
export type InflectCardSignature = {
    readonly 'x-inflect-signature': {
        readonly alg: 'Ed25519';
        readonly keyFingerprint: string;
        /** Ed25519, hex (64 bytes). */
        readonly value: string;
    };
};

export type InflectAgentCard = UnsignedInflectAgentCard & InflectCardSignature;

/**
 * THE HOST-CONSUMER CARD (#3862). Same members as the peer card; two values
 * differ.
 *
 * `skills` lists the workflows carrying reviewed public copy — see the module
 * header for why that is not the caller's grant. `securitySchemes` names the
 * OAuth2 client-credentials flow in the STANDARD members, so a host that reads
 * only the A2A spec can authenticate without knowing anything Inflect-specific:
 * it finds `tokenUrl`, posts its client id and secret, and gets a bearer.
 */
export type UnsignedInflectHostConsumerCard = Omit<
    UnsignedInflectAgentCard,
    'skills' | 'securitySchemes' | 'security'
> & {
    readonly skills: readonly A2aPublicSkill[];
    readonly securitySchemes: {
        readonly hostConsumerOAuth2: {
            readonly type: 'oauth2';
            readonly flows: {
                readonly clientCredentials: {
                    readonly tokenUrl: string;
                    /** Required by the A2A schema; we define no scopes, so it is empty. */
                    readonly scopes: Readonly<Record<string, string>>;
                };
            };
        };
    };
    readonly security: readonly [{ readonly hostConsumerOAuth2: readonly [] }];
};

export type InflectHostConsumerCard = UnsignedInflectHostConsumerCard & InflectCardSignature;

/** Either variant, before signing. What `signInflectAgentCard` accepts. */
export type UnsignedInflectCardVariant = UnsignedInflectAgentCard | UnsignedInflectHostConsumerCard;

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

/**
 * THE HOST-CONSUMER VARIANT. Same input as the peer card plus the skills to
 * advertise, which the caller reads from the workflow registry — this module
 * stays pure.
 *
 * `skills` is sorted by `id` here, not taken in the caller's order. The card is
 * signed over its canonical form, so a peer's pin holds only while the bytes
 * are stable; registry insertion order is not a contract, and sorting makes the
 * document independent of it.
 */
export function buildInflectHostConsumerCard(
    input: InflectAgentCardInput & { readonly skills: readonly A2aPublicSkill[] },
): UnsignedInflectHostConsumerCard {
    const peer = buildInflectAgentCard(input);
    const skills = [...input.skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
        ...peer,
        description:
            'The A2A endpoint of one Inflect workspace, for a host application that calls it as a ' +
            'client. Authenticate with the OAuth2 client credentials the workspace issued, then ' +
            'send a task naming one of the skills below. Which skills a given client may invoke is ' +
            'set by the workspace, so a skill listed here can still be refused.',
        skills,
        securitySchemes: {
            hostConsumerOAuth2: {
                type: 'oauth2',
                flows: {
                    clientCredentials: {
                        tokenUrl: `${input.origin}${inflectA2aTokenPath(input.tenantSlug)}`,
                        scopes: {},
                    },
                },
            },
        },
        security: [{ hostConsumerOAuth2: [] }],
    };
}

/**
 * Sign with the key in force. `key.fingerprint` must be the CURRENT key the
 * card names.
 *
 * Generic over the variant so there is ONE signing path: the bytes signed are
 * the canonical form of every member but the signature, whichever variant it
 * is, and a new variant cannot quietly get a different signing rule.
 */
export function signInflectAgentCard<T extends UnsignedInflectCardVariant>(
    card: T,
    key: { readonly privateKey: KeyObject; readonly fingerprint: string },
): T & InflectCardSignature {
    const current = card['x-inflect'].signingKeys.find((k) => k.status === 'CURRENT');
    if (!current || current.fingerprint !== key.fingerprint) {
        throw new Error('An Inflect agent card is signed only by the key it names as current');
    }
    const value = cryptoSign(null, signedBytes(card as unknown as Record<string, unknown>), key.privateKey).toString(
        'hex',
    );
    // The computed member name defeats inference, so the shape is asserted
    // rather than inferred. `InflectCardSignature` is what makes it true.
    return {
        ...card,
        [SIGNATURE_MEMBER]: { alg: 'Ed25519', keyFingerprint: key.fingerprint, value },
    } as T & InflectCardSignature;
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
