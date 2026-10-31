/**
 * The named refusals an incident action can get (#4697).
 *
 * Each travels in `error.details.reason`, beside an English `error.message`.
 * The incident page maps a known reason to its own translated sentence
 * (`incidents.detail.refused.<reason>`) and falls back to the server's
 * message for anything else, so a Bulgarian user is not shown English for a
 * refusal the page can name.
 *
 * Client-safe: no server imports, so the page can read the reasons.
 */

export const INCIDENT_REFUSALS = [
    /** The incident id names no incident in this workspace. */
    'INCIDENT_NOT_FOUND',
    /** The caller does not hold `incidents.manage`. */
    'INCIDENT_MANAGE_DENIED',
    /** Advance asked of an incident already in its final phase. */
    'INCIDENT_PHASE_FINAL',
    /** A phase change to the phase the incident is already in. */
    'INCIDENT_PHASE_UNCHANGED',
    /** A notification filed before the incident was marked reportable. */
    'INCIDENT_NOT_REPORTABLE',
    /** A containment step that is not in this incident type's runbook. */
    'INCIDENT_STEP_UNKNOWN',
    /** A forensic link to an evidence record this workspace does not hold. */
    'INCIDENT_EVIDENCE_NOT_FOUND',
] as const;

export type IncidentRefusal = (typeof INCIDENT_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(INCIDENT_REFUSALS);

/** The named reason in a parsed API error body, or null when it names none of these. */
export function incidentRefusal(body: unknown): IncidentRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details?.reason;
    return typeof reason === 'string' && KNOWN.has(reason) ? (reason as IncidentRefusal) : null;
}
