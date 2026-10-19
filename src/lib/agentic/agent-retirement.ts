/**
 * AGENT RETIREMENT — the vocabulary the cascade shares (#3698, step 2a).
 *
 * Retiring an agent is one act under one key (`admin.agent_registry`, decided
 * in step 0e): it revokes every credential bound to the agent, drops its tool
 * grants, expires its open proposals, freezes its policy card and closes an
 * open ownership transfer, and withdraws its per-agent evidence artefacts for
 * the periods still open, in ONE transaction. `retireRegisteredAgent` in
 * `src/app-layer/usecases/agent-registry.ts` is the act;
 * `src/app-layer/usecases/agent-retirement-cascade.ts` holds the effects. This
 * module is the part both of them, the database refusals and the tests read,
 * and it carries no server import so a client component can hold it too.
 *
 * ## The evidence effect: per-agent artefacts, open periods only (#3700)
 *
 * The 0e cascade table lists "withdraw its evidence artefacts". Until #3700
 * there was none to withdraw — every `AgenticEvidenceArtefact` was a tenant-wide
 * aggregate, and withdrawing one would have retracted true evidence about every
 * other agent — so #3698 withdrew nothing and recorded the basis
 * `POPULATION_LEVEL_ONLY` (the owner's decision of 2026-10-18, decision 13).
 * The owner then chose, the same day, to add per-agent evidence that a
 * retirement CAN withdraw, as its own step; this is that step.
 *
 * So the cascade now withdraws the agent's PER-AGENT artefacts
 * (`AGENT_ACTION_RECEIPTS_PER_AGENT`, `AI_DECISION_RECORDS_PER_AGENT`) whose
 * period is still OPEN, with reason `AGENT_RETIRED`, and deletes none. Two
 * things it still never does, and each is held by the data, not by care:
 *
 *   • withdraw a TENANT-WIDE artefact — they describe every agent, the
 *     retired one's past actions included, and a DB CHECK refuses an
 *     `AGENT_RETIRED` withdrawal on any row without an agent;
 *   • withdraw a CLOSED period's per-agent artefact — a true record of what
 *     the agent did stays true.
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

/** How many withdrawn evidence-artefact ids the audit row lists. Same contract as above. */
export const RETIREMENT_ARTEFACT_ID_CAP = 200;

/**
 * What the cascade records about the evidence effect: the per-agent artefacts
 * of the periods still open are withdrawn, and nothing else is (#3700).
 *
 * It replaced `POPULATION_LEVEL_ONLY` — "no artefact is attributable to one
 * agent, so none is withdrawn" — which every retirement before #3700 recorded,
 * and which those audit rows keep: the hash-chained trail says what was true
 * when each was written. A statement of fact about the artefact model, not an
 * option a caller picks.
 */
export const RETIREMENT_EVIDENCE_BASIS = 'PER_AGENT_OPEN_PERIODS' as const;

/**
 * The prefix every database refusal in the retirement migration raises with.
 *
 * Every retirement trigger uses it. For a RETIRED agent, an insert of: a
 * PENDING `AgentProposal`, an `AgentPolicyCardVersion` for its card, an
 * `AgentOwnershipTransfer`, an unrevoked `TenantApiKey` (or a re-bind of one),
 * `AgentHarnessScannerKey` or `PeerAgentInboundCredential`, and a
 * `RegisteredAgentTool` grant; and any status
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
    /**
     * Inbound A2A credentials naming the agent as their receiving agent,
     * revoked (#3679, owner decision 2026-10-19): the peer's next message fails
     * at the credential check.
     */
    readonly peerInboundCredentials: RetirementEffectRows;
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
    /**
     * The agent's per-agent evidence artefacts of the periods still open,
     * withdrawn `AGENT_RETIRED` (#3700). `deferredToSweep` when there were more
     * than one retirement withdraws; the next emitter tick withdraws the rest.
     */
    readonly evidenceArtefacts: RetirementEffectRows & { readonly deferredToSweep: boolean };
}

/** The cascade as the response and the summary audit row report it. */
export interface RetirementCascadeSummary {
    readonly apiKeysRevoked: number;
    readonly liveApiKeysRevoked: number;
    readonly scannerKeysRevoked: number;
    readonly peerInboundCredentialsRevoked: number;
    readonly toolGrantsDropped: number;
    readonly proposalsExpired: number;
    readonly policyCardFrozenAtVersion: number | null;
    readonly ownershipTransferCancelled: string | null;
    readonly evidenceArtefactsWithdrawn: number;
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
        peerInboundCredentialsRevoked: effects.peerInboundCredentials.count,
        toolGrantsDropped: effects.toolGrants.count,
        proposalsExpired: effects.proposals.count,
        policyCardFrozenAtVersion: effects.policyCard ? effects.policyCard.frozenAtVersion : null,
        ownershipTransferCancelled: effects.ownershipTransfer
            ? effects.ownershipTransfer.transferId
            : null,
        evidenceArtefactsWithdrawn: effects.evidenceArtefacts.count,
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
