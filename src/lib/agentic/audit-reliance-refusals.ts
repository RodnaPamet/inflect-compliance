/**
 * Why the agent-audit reliance pack could not be assembled.
 *
 * Each travels in the ConflictError's `details.reason`, beside an English
 * message. The cycle page shows its own translated sentence for a known code
 * (`audits.cycleDetail.relianceRefused.<code>`) and falls back to the
 * server's message otherwise (#4727).
 *
 * Client-safe: no imports.
 */
export const RELIANCE_REFUSALS = [
    /** The cycle names no period, so no workpaper can be said to fall inside it. */
    'CYCLE_PERIOD_REQUIRED',
    /** The cycle's period contains no whole month or quarter. */
    'NO_PERIOD_IN_CYCLE',
    /** No library v1 procedure is configured on a control, and none ran. */
    'NO_CONTROLS_IN_SCOPE',
    /** No workpaper of a library v1 procedure falls inside the period. */
    'NO_WORKPAPERS_IN_PERIOD',
    /** More workpapers than one pack holds. */
    'TOO_MANY_WORKPAPERS',
    /** A workpaper in scope whose control cannot be resolved. */
    'WORKPAPER_CONTROL_UNRESOLVED',
] as const;

export type RelianceRefusal = (typeof RELIANCE_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(RELIANCE_REFUSALS);

/** The named reason in a parsed API error body, or null when it names none of these. */
export function relianceRefusal(body: unknown): RelianceRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details?.reason;
    return typeof reason === 'string' && KNOWN.has(reason) ? (reason as RelianceRefusal) : null;
}
