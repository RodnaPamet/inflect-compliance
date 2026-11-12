/**
 * The refusals of a single approve or reject that the review surfaces word
 * themselves, keyed by the server's `error.details.reason` (#4970), as message
 * keys under `agents.proposals.refused`.
 *
 * Shared by the proposal queue and the canvas checkpoint review panel (#5053),
 * which used to show every refusal as the server's English sentence. Anything
 * not listed here, the four-eyes refusals included, is still shown as the
 * server wrote it: those keep WHICH rule refused out of the response by design,
 * so the server's sentence is the only one that says it.
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
    | 'processMapUnreadable';

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
};

/** The worded refusal for an error response body, or null when it is not one of ours. */
export function proposalRefusalKey(body: unknown): ProposalRefusalKey | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details
        ?.reason;
    return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(REFUSAL_KEY, reason)
        ? REFUSAL_KEY[reason]
        : null;
}
