/**
 * The ≤15-minute copy of a peer's agent card that every A2A message is
 * compared against (#3679; owner decision 2026-10-17, threat-model R18).
 *
 * Pinning rule 6: a card is compared with its pin before every message in
 * either direction, against a copy fetched no more than fifteen minutes
 * earlier. When no such copy is held, one is fetched; a fetch that fails
 * REFUSES the message. Fetching on every message would put a third party's
 * latency and uptime in the path of every message, and the owner chose the
 * fifteen-minute bound as the price of not doing so. A change is therefore
 * refused within fifteen minutes of being made, which is residual R18.
 *
 * ## What is cached, and what is not
 *
 * The parsed card and its hashes, per process, keyed by tenant, peer and card
 * URL. NOT the verdict: the pin is read from the database on every message, so
 * a re-approval or a retirement takes effect on the next message, not the next
 * fetch. A failed read is never cached: the next message tries again.
 *
 * Card text sits in memory only, in this map, and is never logged (rule 8).
 */
import {
    fetchAgentCard,
    type AgentCardFetchFailure,
    type AgentCardFetchOptions,
} from '@/lib/agentic/peer-agent-card-fetch';
import type { AgentCard, AgentCardHashes } from '@/lib/agentic/peer-agent-card';

/** The owner's bound (R18). A source constant: changing it is a reviewed diff. */
export const A2A_CARD_MAX_AGE_MS = 15 * 60 * 1000;

/** Bounded so a tenant registering peers in a loop cannot grow it without limit. */
const MAX_ENTRIES = 1000;

interface Entry {
    readonly card: AgentCard;
    readonly hashes: AgentCardHashes;
    readonly fetchedAt: number;
}

const cache = new Map<string, Entry>();

export type RecentCardResult =
    | { readonly ok: true; readonly card: AgentCard; readonly hashes: AgentCardHashes; readonly fetchedAt: Date }
    | { readonly ok: false; readonly reason: AgentCardFetchFailure };

export interface RecentCardOptions extends AgentCardFetchOptions {
    readonly now?: () => number;
    readonly maxAgeMs?: number;
}

/**
 * A copy of the card no older than `maxAgeMs`, from memory or the wire.
 * `maxAgeMs` may only NARROW the owner's bound; a larger value is clamped.
 */
export async function recentAgentCard(
    key: { tenantId: string; peerId: string; cardUrl: string },
    opts: RecentCardOptions = {},
): Promise<RecentCardResult> {
    const now = (opts.now ?? Date.now)();
    const maxAge = Math.min(opts.maxAgeMs ?? A2A_CARD_MAX_AGE_MS, A2A_CARD_MAX_AGE_MS);
    const id = `${key.tenantId}\u0000${key.peerId}\u0000${key.cardUrl}`;
    const held = cache.get(id);
    if (held && now - held.fetchedAt <= maxAge && now >= held.fetchedAt) {
        return { ok: true, card: held.card, hashes: held.hashes, fetchedAt: new Date(held.fetchedAt) };
    }
    cache.delete(id);
    const read = await fetchAgentCard(key.cardUrl, opts);
    if (!read.ok) return { ok: false, reason: read.reason };
    if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(id, { card: read.card, hashes: read.hashes, fetchedAt: now });
    return { ok: true, card: read.card, hashes: read.hashes, fetchedAt: new Date(now) };
}

/** Drop every held copy. For tests, and for nothing else. */
export function clearAgentCardCacheForTests(): void {
    cache.clear();
}
