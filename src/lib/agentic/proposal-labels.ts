/**
 * The names a reviewer reads for a proposal's KIND and for each FIELD its diff
 * lists, as message keys under the `agents` namespace.
 *
 * The queue showed both as stored codes: `RISK`, `EXTERNAL_WRITE`, and field
 * names such as `treatmentNotes` or `compensatingControlId`. A field's stored
 * name is a developer's identifier; the reviewer approving the change is being
 * asked about the record's Treatment notes.
 *
 * ── THE FIELD LIST IS CLOSED, AND A TEST HOLDS IT SO ──────────────────────────
 *
 * A stored payload is the PARSED output of the kind's schema
 * (`createAgentProposal` writes `schema.safeParse(...).data`), so its keys are
 * exactly the schemas' keys: the create and update schemas of the four record
 * kinds and the external-write payload. `tests/unit/agent-proposal-labels.test.ts`
 * reads those schemas and fails when one gains a key this list does not name,
 * or when this list names one no schema has.
 *
 * A name that is not on the list — a row written before a schema lost a field —
 * is shown as stored rather than as a missing-message path, which is the honest
 * rendering of a field nobody has named.
 *
 * NO IMPORTS, so the client diff panel can read it.
 */

/** `AgentProposalKind`, mirrored; the label test compares it with the enum. */
export const PROPOSAL_KINDS = ['RISK', 'CONTROL', 'POLICY', 'FINDING', 'EXTERNAL_WRITE'] as const;

/** Every key a stored proposal payload can carry. */
export const PROPOSAL_FIELD_NAMES = [
    // Risk
    'title',
    'description',
    'category',
    'threat',
    'vulnerability',
    'impact',
    'likelihood',
    'residualLikelihood',
    'residualImpact',
    'scoreJustification',
    'treatment',
    'treatmentOwner',
    'treatmentNotes',
    'ownerUserId',
    'targetDate',
    'nextReviewAt',
    // Control
    'code',
    'annexId',
    'name',
    'status',
    'frequency',
    'evidenceSource',
    'automationKey',
    'automationType',
    'mitigationType',
    'objective',
    'successCriteria',
    'testingMethodology',
    'isCustom',
    'annualCost',
    'effectiveness',
    // Policy
    'reviewFrequencyDays',
    'language',
    'content',
    'contentType',
    'templateId',
    // Finding
    'auditId',
    'severity',
    'type',
    'rootCause',
    'correctiveAction',
    'analysis',
    'owner',
    'assigneeUserId',
    'controlId',
    'compensatingControlId',
    'riskIds',
    'dueDate',
    'sourceKind',
    'sourceRef',
    'verificationNotes',
    // External write
    'connectionId',
    'connectionName',
    'endpointUrl',
    'toolName',
    'advertisedToolName',
    'arguments',
    'priorState',
] as const;

const KINDS: ReadonlySet<string> = new Set(PROPOSAL_KINDS);
const FIELDS: ReadonlySet<string> = new Set(PROPOSAL_FIELD_NAMES);

/** The `agents` message key naming a proposal kind, or null for a kind not on the list. */
export function proposalKindLabelKey(kind: string): string | null {
    return KINDS.has(kind) ? `proposals.kind.${kind}` : null;
}

/** The `agents` message key naming a payload field, or null for a field not on the list. */
export function proposalFieldLabelKey(field: string): string | null {
    return FIELDS.has(field) ? `proposals.field.${field}` : null;
}
