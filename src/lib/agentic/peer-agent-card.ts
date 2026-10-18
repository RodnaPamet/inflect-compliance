/**
 * A2A peer agent cards: parse, hash, compare, admit (#3673, step 2e).
 *
 * A peer is an agent in ANOTHER organisation. Its agent card is the A2A
 * counterpart of an MCP tool definition: text a model will read, written by
 * somebody this tenant does not control. So it is pinned on the reasoning
 * `src/lib/mcp/tool-manifest.ts` pins tools on, with one difference that is the
 * whole point: there is NO trust on first use. A peer with no pin a person
 * approved is refused (`docs/a2a-threat-model.md`, pinning rule 1).
 *
 * Everything here is pure. Fetching a card is `peer-agent-card-fetch.ts`;
 * storing a pin is `usecases/peer-agents.ts`.
 *
 * ## The hash
 *
 * `cardHash` is what the gate compares. It is domain-separated and
 * version-prefixed (`a2a-agent-card/v1`), so a change to the derivation reads
 * as drift on every pin rather than as silent agreement (rule 2).
 *
 * Beside it, three component hashes say WHAT moved, so an operator asked to
 * re-approve learns whether the instructions changed or the plumbing did
 * (rule 3):
 *
 *   textHash      — what a model reads: the card's name and description, and
 *                   each skill's name, description and examples
 *   endpointHash  — where traffic goes and how it authenticates
 *   otherHash     — everything else, the protocol version included
 *
 * `cardHash` is built over the three AND a hash of the whole canonical card.
 * The components are a partition of the card, but a partition is a claim this
 * module makes about itself; folding the whole card in means a field the
 * partition forgot still moves `cardHash`. The components explain a change;
 * only `cardHash` decides one.
 *
 * ## Why text goes through `JSON.stringify` and not straight to SHA-256
 *
 * Free text is hashed as its exact code units: no trimming, no whitespace
 * collapsing, no Unicode normalisation, because zero-width and bidirectional
 * characters are how instruction text hides. Hashing a JS string with
 * `update(text, 'utf8')` does NOT have that property: UTF-8 encoding replaces
 * every lone surrogate with U+FFFD, so two different texts hash alike.
 * `JSON.stringify` escapes a lone surrogate as `\udXXX` instead, and is
 * injective over strings. So each piece of text is hashed through it.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '@/lib/canonical-json';

/** The derivation's version. Bump it and every pin reads as drift, on purpose. */
export const AGENT_CARD_HASH_VERSION = 'a2a-agent-card/v1';

/** The largest card read off the wire. A card is a description, not a payload. */
export const AGENT_CARD_MAX_BYTES = 64 * 1024;

/** The card fields that say where traffic goes and how it authenticates. */
const ENDPOINT_FIELDS = ['url', 'preferredTransport', 'additionalInterfaces', 'securitySchemes', 'security'] as const;

const SkillSchema = z
    .object({
        id: z.string().min(1).max(256),
        name: z.string().max(1024),
        description: z.string().max(16_384),
        examples: z.array(z.string().max(16_384)).max(64).optional(),
    })
    .passthrough();

/**
 * The fields a card MUST carry for this product to say what it is pinning.
 * Every other field is kept (`passthrough`) and pinned: the pin covers the whole
 * card as served, so an unknown field is a hashed field, never a dropped one.
 */
const AgentCardSchema = z
    .object({
        name: z.string().min(1).max(1024),
        description: z.string().max(16_384),
        url: z.string().url().max(2048),
        skills: z.array(SkillSchema).max(128),
    })
    .passthrough();

export type AgentCard = z.infer<typeof AgentCardSchema>;

export type AgentCardParseResult =
    | { readonly ok: true; readonly card: AgentCard }
    | { readonly ok: false; readonly reason: 'NOT_JSON' | 'NOT_AN_AGENT_CARD' | 'ENDPOINT_NOT_HTTPS' };

/**
 * Parse a card from the text the peer served. A card that cannot be
 * characterised is refused rather than pinned: approving bytes nobody could
 * read is not a review.
 */
export function parseAgentCard(text: string): AgentCardParseResult {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'NOT_JSON' };
    }
    const parsed = AgentCardSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'NOT_AN_AGENT_CARD' };
    // The card's service endpoint is where 4b will send work. A card naming a
    // plaintext endpoint is refused now, not discovered then.
    if (!parsed.data.url.startsWith('https://')) return { ok: false, reason: 'ENDPOINT_NOT_HTTPS' };
    return { ok: true, card: parsed.data };
}

export interface AgentCardHashes {
    readonly cardHash: string;
    readonly textHash: string;
    readonly endpointHash: string;
    readonly otherHash: string;
}

function sha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** One piece of free text, hashed as its exact code units (see the header). */
function textDigest(text: string): string {
    return sha256(JSON.stringify(text));
}

/**
 * Hash a parsed card. The card is round-tripped through JSON first, so the
 * hashed value is the wire value and nothing a parser attached (a `toJSON`, a
 * prototype) can make the two differ.
 */
export function hashAgentCard(card: AgentCard): AgentCardHashes {
    const wire = JSON.parse(JSON.stringify(card)) as Record<string, unknown> & AgentCard;

    const textHash = sha256(
        canonicalJson({
            name: textDigest(wire.name),
            description: textDigest(wire.description),
            skills: wire.skills.map((s) => ({
                name: textDigest(s.name),
                description: textDigest(s.description),
                examples: s.examples === undefined ? null : s.examples.map(textDigest),
            })),
        }),
    );

    const endpoint: Record<string, unknown> = {};
    for (const f of ENDPOINT_FIELDS) endpoint[f] = wire[f] ?? null;
    const endpointHash = sha256(canonicalJson(endpoint));

    // Everything the two above did not take. Removing a key here only decides
    // which component EXPLAINS a change; `cardHash` below still covers it.
    const rest: Record<string, unknown> = { ...wire };
    delete rest.name;
    delete rest.description;
    for (const f of ENDPOINT_FIELDS) delete rest[f];
    rest.skills = wire.skills.map((s) => {
        const skillRest: Record<string, unknown> = { ...s };
        delete skillRest.name;
        delete skillRest.description;
        delete skillRest.examples;
        return skillRest;
    });
    const otherHash = sha256(canonicalJson(rest));

    const cardHash = sha256(
        canonicalJson({
            v: AGENT_CARD_HASH_VERSION,
            whole: sha256(canonicalJson(wire)),
            textHash,
            endpointHash,
            otherHash,
        }),
    );
    return { cardHash, textHash, endpointHash, otherHash };
}

/** Which components differ between a live card and the pin. Empty when they agree. */
export type CardComponent = 'TEXT' | 'ENDPOINT' | 'OTHER';

export interface PinnedCardHashes extends AgentCardHashes {
    readonly revision: number;
}

export type CardVerdict =
    | { readonly status: 'UNPINNED' }
    | { readonly status: 'MATCH'; readonly revision: number }
    | { readonly status: 'CHANGED'; readonly revision: number; readonly moved: readonly CardComponent[] };

/**
 * Compare a live card with the pin. `CHANGED` with an empty `moved` list is a
 * real outcome — the whole-card term caught what no component did — and it
 * still refuses.
 */
export function compareAgentCard(live: AgentCardHashes, pin: PinnedCardHashes | null): CardVerdict {
    if (!pin) return { status: 'UNPINNED' };
    if (live.cardHash === pin.cardHash) return { status: 'MATCH', revision: pin.revision };
    const moved: CardComponent[] = [];
    if (live.textHash !== pin.textHash) moved.push('TEXT');
    if (live.endpointHash !== pin.endpointHash) moved.push('ENDPOINT');
    if (live.otherHash !== pin.otherHash) moved.push('OTHER');
    return { status: 'CHANGED', revision: pin.revision, moved };
}

/**
 * Why a peer may not exchange a task. The order is the order they are checked
 * in, and the first that applies is the one reported.
 */
export type PeerRefusal =
    | 'PEER_NOT_ACTIVE'
    | 'PEER_OWNER_INACTIVE'
    | 'PEER_UNSCORED'
    | 'PEER_UNPINNED'
    | 'PEER_CARD_UNREADABLE'
    | 'PEER_CARD_CHANGED';

export interface PeerAdmissionInput {
    readonly status: string;
    /** Whether the accountable owner is still an ACTIVE member of the tenant. */
    readonly ownerActive: boolean;
    readonly riskTier: string | null;
    readonly pin: PinnedCardHashes | null;
    /** The card as served now, or `null` when it could not be read. */
    readonly live: AgentCardHashes | null;
}

export type PeerAdmission =
    | { readonly admitted: true; readonly revision: number }
    | { readonly admitted: false; readonly reason: PeerRefusal; readonly verdict: CardVerdict | null };

/**
 * Whether a peer may exchange a task now. Deny by default: every input that is
 * missing, unknown or unreadable refuses, and only the one fully-satisfied
 * shape admits. This is the gate step 4b calls before every message; 2e builds
 * it and calls it from the admin surface.
 *
 * The verdict rides along on a card refusal so the CALLER can audit what
 * moved. It must never reach the peer or the agent: a refusal that describes
 * the change is a confirmation oracle for whoever is making it (rule 7).
 */
export function evaluatePeerAdmission(input: PeerAdmissionInput): PeerAdmission {
    if (input.status !== 'ACTIVE') return { admitted: false, reason: 'PEER_NOT_ACTIVE', verdict: null };
    if (!input.ownerActive) return { admitted: false, reason: 'PEER_OWNER_INACTIVE', verdict: null };
    // An unscored tier means deny, as a null `RegisteredAgent.riskTier` does.
    if (input.riskTier === null) return { admitted: false, reason: 'PEER_UNSCORED', verdict: null };
    if (!input.pin) return { admitted: false, reason: 'PEER_UNPINNED', verdict: { status: 'UNPINNED' } };
    if (!input.live) return { admitted: false, reason: 'PEER_CARD_UNREADABLE', verdict: null };
    const verdict = compareAgentCard(input.live, input.pin);
    if (verdict.status !== 'MATCH') return { admitted: false, reason: 'PEER_CARD_CHANGED', verdict };
    return { admitted: true, revision: verdict.revision };
}
