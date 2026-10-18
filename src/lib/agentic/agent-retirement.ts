/**
 * AGENT RETIREMENT — the vocabulary the cascade shares (#3698, step 2a).
 *
 * Retiring an agent is one act under one key (`admin.agent_registry`, decided
 * in step 0e): it revokes every credential bound to the agent, drops its tool
 * grants, expires its open proposals, freezes its policy card and closes an
 * open ownership transfer, in ONE transaction. `retireRegisteredAgent` in
 * `src/app-layer/usecases/agent-registry.ts` is the act;
 * `src/app-layer/usecases/agent-retirement-cascade.ts` holds the effects. This
 * module is the part both of them, the database refusals and the tests read,
 * and it carries no server import so a client component can hold it too.
 *
 * ## Why the evidence effect is a recorded basis rather than a write
 *
 * The 0e cascade table lists "withdraw its evidence artefacts". There is no
 * artefact to withdraw. An `AgenticEvidenceArtefact` is keyed
 * `(tenant, control, kind, period)` with no agent column, and its body and
 * digest are computed over the WHOLE tenant's receipts or decisions for the
 * month (`loadReceiptFacts` / `loadDecisionFacts` in
 * `agentic-evidence-emission.ts`). Only a count and a digest are stored, so the
 * population cannot be split by agent afterwards. Withdrawing one would
 * retract true evidence about every other agent, and about the retired agent's
 * own past actions — and the current month would be re-emitted CURRENT by the
 * next 06:30 UTC run anyway. So the cascade withdraws nothing, and says so on
 * its audit row (`evidenceBasis`), rather than skipping the effect in silence.
 *
 * This is the owner's decision (2026-10-18), not a gap left open: retirement
 * withdraws NO evidence artefact. Per-agent evidence that a retirement could
 * withdraw is its OWN future roadmap step — #3700, which would add an
 * agent-attributable artefact kind, per-agent emission and a withdrawal reason
 * for it. Until that step exists there is nothing for this cascade to target,
 * and it must not be "completed" here by withdrawing tenant-wide artefacts.
 */

/**
 * How many proposal ids the audit row lists. The WRITE is not bounded — zero
 * open proposals must mean zero — only the list of ids the row carries, and the
 * row says when it was cut (`idsTruncated`). Same figure as the expiry sweep's
 * batch, for the same reason: each id is bytes in a hash-chained row.
 */
export const RETIREMENT_PROPOSAL_ID_CAP = 500;

/** How many credential ids the audit row lists. Same contract as above. */
export const RETIREMENT_KEY_ID_CAP = 200;

/**
 * What the cascade records about the evidence effect. One value today, and it
 * is a statement of fact about the artefact model rather than an option: every
 * artefact is a tenant-wide population, so none is attributable to one agent.
 * Withdrawing nothing is the owner's accepted outcome (2026-10-18); a per-agent
 * artefact that retirement could withdraw belongs to #3700, which
 * would add a second basis value here rather than change this one.
 */
export const RETIREMENT_EVIDENCE_BASIS = 'POPULATION_LEVEL_ONLY' as const;

/**
 * The prefix every database refusal in the retirement migration raises with.
 *
 * Every retirement trigger uses it. For a RETIRED agent, an insert of: a
 * PENDING `AgentProposal`, an `AgentPolicyCardVersion` for its card, an
 * `AgentOwnershipTransfer`, an unrevoked `TenantApiKey` (or a re-bind of one) or
 * `AgentHarnessScannerKey`, and a `RegisteredAgentTool` grant; and any status
 * change OUT of RETIRED. Each insert trigger takes `FOR SHARE` on the agent row,
 * which is what closes the race the usecase cannot see — the agent being
 * retired between the usecase's unlocked read and its write — and each usecase
 * maps the message to the same typed error it would have raised.
 */
export const AGENT_RETIRED_DB_REFUSAL = 'AGENT_RETIRED';

/**
 * Whether an error is one of the retirement triggers' refusals.
 *
 * Matched on the message, the way `fourEyesRefusal` matches its triggers: the
 * driver adapter does not surface the SQLSTATE in one stable place, and the
 * prefix is ours. That is also why the triggers raise the DEFAULT SQLSTATE and
 * not `restrict_violation`: Prisma renders 23001 as "Foreign key constraint
 * violated" and the message — the prefix — is gone. Anything else is NOT one,
 * and the caller rethrows it untouched — a broken database must not read as the
 * control working.
 */
export function isAgentRetiredDbRefusal(err: unknown): boolean {
    const text = err instanceof Error ? err.message : '';
    return text.includes(`${AGENT_RETIRED_DB_REFUSAL}:`);
}

/** One effect that took authority away: how many rows, and which (bounded). */
export interface RetirementEffectRows {
    /** Rows the write changed. Authoritative: it is the UPDATE/DELETE's own count. */
    readonly count: number;
    /** The ids it changed, at most the cap. */
    readonly ids: readonly string[];
    /** True when `count` exceeded the cap, so `ids` is a prefix. */
    readonly idsTruncated: boolean;
}

/** Everything one retirement changed, in the order the cascade wrote it. */
export interface RetirementCascadeEffects {
    /**
     * Every `TenantApiKey` bound to the agent that was not yet revoked —
     * including keys already past their `expiresAt`, so that "no key bound to a
     * retired agent is unrevoked" does not depend on the clock.
     */
    readonly apiKeys: RetirementEffectRows & {
        /**
         * How many of them were LIVE (unexpired) when revoked — the number the
         * retire dialog previewed, by the same predicate as `getById`'s
         * `_count.apiKeys`. The rest were already dead.
         */
        readonly liveCount: number;
    };
    /** Harness scanner signing keys bound to the agent, revoked. */
    readonly scannerKeys: RetirementEffectRows;
    /** `RegisteredAgentTool` grants, deleted. `names` are the tools it held. */
    readonly toolGrants: { readonly count: number; readonly names: readonly string[] };
    /** `AgentProposal` rows moved PENDING → EXPIRED. */
    readonly proposals: RetirementEffectRows;
    /**
     * The policy card, frozen at the version in force — or null when the agent
     * never had one. Read only: the freeze is the refusal at the write seam and
     * the trigger, not a write here.
     */
    readonly policyCard: { readonly cardId: string; readonly frozenAtVersion: number } | null;
    /**
     * The agent's open ownership transfer, cancelled — or null when none was
     * open. A retired agent can never be completed into, so the act that made
     * the transfer impossible closes it rather than leaving it to lapse.
     */
    readonly ownershipTransfer: { readonly transferId: string; readonly toOwnerUserId: string } | null;
}

/** The cascade as the response and the summary audit row report it. */
export interface RetirementCascadeSummary {
    readonly apiKeysRevoked: number;
    readonly liveApiKeysRevoked: number;
    readonly scannerKeysRevoked: number;
    readonly toolGrantsDropped: number;
    readonly proposalsExpired: number;
    readonly policyCardFrozenAtVersion: number | null;
    readonly ownershipTransferCancelled: string | null;
    readonly evidenceArtefactsWithdrawn: 0;
    readonly evidenceBasis: typeof RETIREMENT_EVIDENCE_BASIS;
}

/** Fold the effects into the summary. Pure, so the response and the row cannot disagree. */
export function summariseRetirementCascade(
    effects: RetirementCascadeEffects,
): RetirementCascadeSummary {
    return {
        apiKeysRevoked: effects.apiKeys.count,
        liveApiKeysRevoked: effects.apiKeys.liveCount,
        scannerKeysRevoked: effects.scannerKeys.count,
        toolGrantsDropped: effects.toolGrants.count,
        proposalsExpired: effects.proposals.count,
        policyCardFrozenAtVersion: effects.policyCard ? effects.policyCard.frozenAtVersion : null,
        ownershipTransferCancelled: effects.ownershipTransfer
            ? effects.ownershipTransfer.transferId
            : null,
        evidenceArtefactsWithdrawn: 0,
        evidenceBasis: RETIREMENT_EVIDENCE_BASIS,
    };
}

/**
 * Cut a list of ids to the cap, and say whether the list is SHORT of the write.
 *
 * The list and the write are two statements, so they can disagree, and the
 * flag must follow the disagreement rather than the cap: a list that holds
 * fewer ids than rows the write changed is flagged, whether the cap cut it or
 * a row arrived between the two statements. (The insert triggers of the
 * retirement migration are what keep that second case from arising for this
 * agent; the flag does not rely on them.)
 */
export function boundedIds(
    ids: readonly string[],
    count: number,
    cap: number,
): { ids: readonly string[]; idsTruncated: boolean } {
    const listed = ids.slice(0, cap);
    return { ids: listed, idsTruncated: listed.length < count || ids.length > cap };
}
