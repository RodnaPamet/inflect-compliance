/**
 * WHO MAY ACCEPT A HARNESS SHORTFALL — one rule, two readers (#3687).
 *
 * `acceptHarnessShortfall` refuses with it, and the harness tab decides from it
 * whether to show the accept action. A button computed by a second rule would
 * be shown and then refused, or hidden from the one person entitled to it, so
 * both sides call this module over the SAME columns: the discovered agent's
 * `lastLevel` / `lastReach` (the latest ingested reading — what the usecase
 * reads) and its register row's owner and soft-delete stamp.
 *
 * The order is the usecase's and is load-bearing: a shadow agent is refused
 * for being shadow before anyone asks whose it is, and a non-owner is refused
 * before being told whether there is anything to accept.
 *
 * CLIENT-SAFE: it imports the findings planner, whose own imports are the
 * ladder and a type-only contract import. No user id leaves the server — the
 * server computes the affordance and the client renders it.
 */
import { isHarnessShortfall, type StoredReach } from './harness-findings';
import type { HarnessLevel } from './harness-ladder';
import type { AcceptAffordance } from './harness-read-model';

/** The longest an acceptance may run before it must be renewed. */
export const MAX_ACCEPTANCE_DAYS = 365;
/** A justification is a reason, not a word. */
export const JUSTIFICATION_MIN_CHARS = 20;
export const JUSTIFICATION_MAX_CHARS = 4_000;

/** What the rule reads about one discovered agent. */
export interface AcceptanceSubject {
    readonly lastLevel: HarnessLevel;
    readonly lastReach: StoredReach;
    readonly registeredAgent: {
        readonly ownerUserId: string | null;
        readonly deletedAt: Date | string | null;
    } | null;
}

export type ShortfallAcceptanceRefusal = 'SHADOW' | 'NOT_OWNER' | 'NO_SHORTFALL';

/** Why `userId` may not accept this agent's shortfall, or `null` when they may. */
export function shortfallAcceptanceRefusal(
    agent: AcceptanceSubject,
    userId: string,
): ShortfallAcceptanceRefusal | null {
    if (agent.registeredAgent === null || agent.registeredAgent.deletedAt !== null) return 'SHADOW';
    if (agent.registeredAgent.ownerUserId !== userId) return 'NOT_OWNER';
    if (!isHarnessShortfall(agent.lastLevel, agent.lastReach)) return 'NO_SHORTFALL';
    return null;
}

/**
 * What the tab offers `userId` for this agent. Only `ACCEPT` and `RENEW` are
 * actions; `OWNER_ONLY` and `REGISTER_FIRST` are notes that explain why there
 * is no action on a row that is short of its bar, and an agent that is not
 * short gets `NONE` whoever is looking — a note on a row with nothing to
 * accept would be noise.
 */
export function acceptAffordanceFor(
    agent: AcceptanceSubject,
    userId: string,
    acceptanceInForce: boolean,
): AcceptAffordance {
    const refusal = shortfallAcceptanceRefusal(agent, userId);
    if (refusal === null) return acceptanceInForce ? 'RENEW' : 'ACCEPT';
    if (!isHarnessShortfall(agent.lastLevel, agent.lastReach)) return 'NONE';
    return refusal === 'SHADOW' ? 'REGISTER_FIRST' : 'OWNER_ONLY';
}
