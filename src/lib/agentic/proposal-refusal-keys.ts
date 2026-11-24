/**
 * The refusals of a single approve or reject that the review surfaces word
 * themselves, keyed by the server's `error.details.reason` (#4970), as message
 * keys under `agents.proposals.refused`.
 *
 * Shared by the proposal queue and the canvas checkpoint review panel (#5053),
 * which used to show every refusal as the server's English sentence. Anything
 * not listed here is still shown as the server wrote it.
 *
 * The four-eyes refusals are listed one per rule (#5919). They used to share
 * the one reason `agent_proposal_four_eyes`, which could not be mapped: the same
 * code meant "you own the agent", "you have already signed" and "not found", so
 * a Bulgarian reader got the server's English sentence.
 *
 * NO IMPORTS, so a client component can read it.
 */

export type ProposalRefusalKey =
    | 'composer'
    | 'ownDissent'
    | 'unknownDissent'
    | 'expired'
    | 'processMapNotAvailable'
    | 'processMapNotEditable'
    | 'processMapNeedsProcessesEdit'
    | 'processMapUnreadable'
    | 'findingNeedsCreate'
    | 'findingNeedsEdit'
    | 'riskNeedsCreate'
    | 'riskNeedsEdit'
    | 'controlNeedsCreate'
    | 'controlNeedsEdit'
    | 'policyNeedsCreate'
    | 'policyNeedsEdit'
    | 'fourEyesOwner'
    | 'fourEyesAlreadySigned'
    | 'fourEyesNotFound';

const REFUSAL_KEY: Readonly<Record<string, ProposalRefusalKey>> = {
    COMPOSER_MAY_NOT_APPROVE: 'composer',
    DISSENT_AUTHOR_MAY_NOT_DECIDE: 'ownDissent',
    DISSENT_AUTHOR_UNKNOWN: 'unknownDissent',
    agent_proposal_expired: 'expired',
    // #5053: a process-map proposal is read, and not yet approved.
    PROCESS_MAP_PROPOSALS_NOT_AVAILABLE: 'processMapNotAvailable',
    // #5053, deploy 2: a map is approved exactly as proposed, by somebody who
    // may edit process maps, and only while its stored payload still reads.
    PROCESS_MAP_PROPOSAL_NOT_EDITABLE: 'processMapNotEditable',
    PROCESS_MAP_APPROVER_NEEDS_PROCESSES_EDIT: 'processMapNeedsProcessesEdit',
    PROCESS_MAP_PROPOSAL_UNREADABLE: 'processMapUnreadable',
    // #5369: a finding's or a risk's approver holds the key its route takes.
    FINDING_APPROVER_NEEDS_FINDINGS_CREATE: 'findingNeedsCreate',
    FINDING_APPROVER_NEEDS_FINDINGS_EDIT: 'findingNeedsEdit',
    RISK_APPROVER_NEEDS_RISKS_CREATE: 'riskNeedsCreate',
    RISK_APPROVER_NEEDS_RISKS_EDIT: 'riskNeedsEdit',
    CONTROL_APPROVER_NEEDS_CONTROLS_CREATE: 'controlNeedsCreate',
    CONTROL_APPROVER_NEEDS_CONTROLS_EDIT: 'controlNeedsEdit',
    POLICY_APPROVER_NEEDS_POLICIES_CREATE: 'policyNeedsCreate',
    POLICY_APPROVER_NEEDS_POLICIES_EDIT: 'policyNeedsEdit',
    // #5919: the database's four-eyes refusals, one reason per rule.
    agent_proposal_four_eyes_owner: 'fourEyesOwner',
    agent_proposal_four_eyes_already_signed: 'fourEyesAlreadySigned',
    agent_proposal_four_eyes_not_found: 'fourEyesNotFound',
};

/** The worded refusal for an error response body, or null when it is not one of ours. */
export function proposalRefusalKey(body: unknown): ProposalRefusalKey | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details
        ?.reason;
    return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(REFUSAL_KEY, reason)
        ? REFUSAL_KEY[reason]
        : null;
}
