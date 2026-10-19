/**
 * THE AUDITOR IS NOT THE AUDITEE — the auditor independence rule (#3675, step
 * 3b; roadmap rule 8 and decision 3).
 *
 * An agent marked `RegisteredAgent.isAuditor` re-performs audit procedures and
 * writes workpapers. It is independent only when its accountable owner:
 *
 *   1. holds an ACTIVE membership of the tenant;
 *   2. has a DECLARED line of defence, and it is SECOND — the second line owns
 *      and operates the auditor agent. A NULL line is "not declared" and never
 *      satisfies the check: an undeclared owner is refused, not presumed;
 *   3. owns NONE of the audited agents — every other registered agent of the
 *      tenant that is not itself an auditor, not RETIRED and not soft-deleted.
 *      DRAFT and SUSPENDED agents count: each can be put back into service by
 *      the register's ordinary act, and an auditor whose owner's agent is merely
 *      paused is still auditing that owner's agent.
 *
 * Pure: the facts are read by `src/app-layer/usecases/auditor-independence.ts`,
 * and the trigger `registered_agent_auditor_independence` reads the same three
 * facts in SQL, in the same order, with the same reason codes.
 *
 * WHEN IT IS A REFUSAL AND WHEN IT IS A FINDING. The rule refuses at the two
 * moments an agent's standing as an auditor is being granted: when it BECOMES
 * an auditor (registered as one, or amended into one) and when an auditor goes
 * ACTIVE. Any LATER change that breaks it — an ownership transfer, a new agent
 * registered to the auditor's owner, the owner's line moved off SECOND, another
 * auditor of the same owner unmarked — raises a finding against the auditor
 * and does not suspend it: the issue asks for a finding, and the changes that
 * cause a break are accountable acts (a transfer, an OWNER's declaration) that
 * a refusal would block.
 */

/** `LineOfDefence` (prisma/schema/enums.prisma), spelled out so a client module can hold it. */
export type LineOfDefenceValue = 'FIRST' | 'SECOND' | 'THIRD';

export const LINES_OF_DEFENCE: readonly LineOfDefenceValue[] = ['FIRST', 'SECOND', 'THIRD'] as const;

/** The line that owns and operates an auditor agent (decision 3). */
export const AUDITOR_OWNER_LINE: LineOfDefenceValue = 'SECOND';

/** The line that samples workpapers and stamps their review: internal audit. */
export const WORKPAPER_REVIEWER_LINE: LineOfDefenceValue = 'THIRD';

/**
 * Why an auditor is not independent, in the order the check asks. The trigger
 * raises the same codes, after `AUDITOR_NOT_INDEPENDENT: `.
 */
export type AuditorIndependenceReason =
    | 'OWNER_NOT_ACTIVE_MEMBER'
    | 'OWNER_LINE_UNDECLARED'
    | 'OWNER_NOT_SECOND_LINE'
    | 'OWNER_OWNS_AUDITED_AGENT';

export const AUDITOR_INDEPENDENCE_REASONS: readonly AuditorIndependenceReason[] = [
    'OWNER_NOT_ACTIVE_MEMBER',
    'OWNER_LINE_UNDECLARED',
    'OWNER_NOT_SECOND_LINE',
    'OWNER_OWNS_AUDITED_AGENT',
] as const;

/** The refusal's top-level `details.reason`, beside the specific reasons. */
export const AUDITOR_NOT_INDEPENDENT = 'AUDITOR_NOT_INDEPENDENT' as const;

/** The SQLSTATE P0001 message prefix the trigger raises. */
export const AUDITOR_NOT_INDEPENDENT_DB_REFUSAL = 'AUDITOR_NOT_INDEPENDENT:';

/** What the rule reads about one auditor's owner. */
export interface AuditorOwnerFacts {
    /** The owner's membership status in the tenant, or null when they hold no row at all. */
    readonly membershipStatus: string | null;
    /** The owner's declared line, or null when undeclared (or there is no membership). */
    readonly lineOfDefence: LineOfDefenceValue | null;
    /** The audited agents the owner owns (never the auditor itself). */
    readonly auditedAgentIds: readonly string[];
}

export type AuditorIndependenceVerdict =
    | { readonly independent: true }
    | {
          readonly independent: false;
          /** Every reason that holds, in check order. Never empty. */
          readonly reasons: readonly AuditorIndependenceReason[];
          readonly auditedAgentIds: readonly string[];
      };

/**
 * Judge one auditor's owner. Every failing term is reported, not only the
 * first, so a finding states the whole problem rather than the first half of
 * it. The line is asked only of an ACTIVE member: an owner who is not one has
 * no line that counts, and "inactive" is the fact to report.
 */
export function evaluateAuditorIndependence(facts: AuditorOwnerFacts): AuditorIndependenceVerdict {
    const reasons: AuditorIndependenceReason[] = [];
    if (facts.membershipStatus !== 'ACTIVE') reasons.push('OWNER_NOT_ACTIVE_MEMBER');
    else if (facts.lineOfDefence === null) reasons.push('OWNER_LINE_UNDECLARED');
    else if (facts.lineOfDefence !== AUDITOR_OWNER_LINE) reasons.push('OWNER_NOT_SECOND_LINE');
    if (facts.auditedAgentIds.length > 0) reasons.push('OWNER_OWNS_AUDITED_AGENT');
    if (reasons.length === 0) return { independent: true };
    return { independent: false, reasons, auditedAgentIds: [...facts.auditedAgentIds].sort() };
}

/**
 * Is this register row an AUDITED agent — one an auditor must not share an
 * owner with? Every agent that is not itself an auditor, not RETIRED and not
 * soft-deleted. The trigger's `count(*)` and the usecase's query state the same
 * predicate.
 */
export function isAuditedAgent(agent: {
    readonly isAuditor: boolean;
    readonly status: string;
    readonly deletedAt: Date | null;
}): boolean {
    return !agent.isAuditor && agent.status !== 'RETIRED' && agent.deletedAt === null;
}

/** The finding an independence break raises — one per auditor, reopened rather than duplicated. */
export const AUDITOR_INDEPENDENCE_FINDING_SOURCE_KIND = 'AUDITOR_INDEPENDENCE';

/**
 * HIGH, a NONCONFORMITY. Not CRITICAL: no agent action becomes unconstrained
 * and no data moves — the auditor's grants, card and kill switch are untouched.
 * Not lower: from the break on, the auditor's workpapers are the auditee
 * auditing itself, so the workpaper seam refuses to record any
 * (`AUDITOR_NOT_INDEPENDENT`) and every procedure it runs goes unevidenced until
 * the break is fixed.
 */
export const AUDITOR_INDEPENDENCE_FINDING_SEVERITY = 'HIGH' as const;
export const AUDITOR_INDEPENDENCE_FINDING_TYPE = 'NONCONFORMITY' as const;

/** The change that led a reconcile to look, recorded on the finding. */
export type IndependenceBreakTrigger =
    | 'OWNERSHIP_TRANSFER'
    | 'LINE_OF_DEFENCE_CHANGE'
    | 'AGENT_REGISTERED'
    | 'AUDITOR_UNMARKED';

const REASON_TEXT: Record<AuditorIndependenceReason, string> = {
    OWNER_NOT_ACTIVE_MEMBER: 'its owner holds no ACTIVE membership of this workspace',
    OWNER_LINE_UNDECLARED: "its owner's line of defence is not declared",
    OWNER_NOT_SECOND_LINE: 'its owner is not in the second line of defence',
    OWNER_OWNS_AUDITED_AGENT: 'its owner also owns agents it audits',
};

const TRIGGER_TEXT: Record<IndependenceBreakTrigger, string> = {
    OWNERSHIP_TRANSFER: 'an ownership transfer',
    LINE_OF_DEFENCE_CHANGE: "a change to the owner's line of defence",
    AGENT_REGISTERED: 'a new agent registered to the same owner',
    AUDITOR_UNMARKED: 'another agent of the same owner no longer being an auditor',
};

/** The sentence a refusal or a finding carries for each reason. */
export function independenceReasonText(reason: AuditorIndependenceReason): string {
    return REASON_TEXT[reason];
}

/**
 * The finding's title and description. Identifiers and codes, never a person's
 * name or address: the finding is read by people who may not see the members
 * list, and the owner is the agent's `ownerUserId`, which the register shows.
 */
export function independenceFindingText(input: {
    readonly agentId: string;
    readonly agentName: string;
    readonly reasons: readonly AuditorIndependenceReason[];
    readonly auditedAgentIds: readonly string[];
    readonly trigger: IndependenceBreakTrigger;
}): { title: string; description: string } {
    const shown = input.auditedAgentIds.slice(0, 20);
    const more = input.auditedAgentIds.length - shown.length;
    const audited =
        shown.length === 0
            ? ''
            : ` Audited agents its owner owns: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
    return {
        title: `Auditor agent "${input.agentName}" is not independent of the agents it audits`,
        description:
            `Auditor agent ${input.agentId} no longer meets the independence rule: ` +
            `${input.reasons.map((r) => `${independenceReasonText(r)} (${r})`).join('; ')}. ` +
            `Found after ${TRIGGER_TEXT[input.trigger]}.${audited} ` +
            'An auditor agent must be owned by a second-line member who owns none of the agents it ' +
            'audits. The auditor was not suspended; until this is fixed it cannot record a ' +
            'workpaper. Fix it by transferring the auditor to an independent second-line owner, ' +
            "transferring the audited agents away, or correcting the owner's declared line.",
    };
}
