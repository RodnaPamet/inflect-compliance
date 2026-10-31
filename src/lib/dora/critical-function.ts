/**
 * DORA's one distinction for the Register of Information: does an ICT
 * arrangement support a critical or important function? Those carry the
 * heavier contractual, exit-plan and register obligations.
 *
 * Inflect records vendor criticality, not a separate critical-function flag,
 * so CRITICAL and HIGH are read as "yes". The register page says so in its
 * scope note rather than presenting a derived answer as a recorded one.
 *
 * One definition, read by the page's rows AND by the count the server takes
 * over the whole register (#4639), so the figure in the header and the badge
 * on each row cannot disagree.
 */
export const CRITICAL_FUNCTION_CRITICALITIES = ['CRITICAL', 'HIGH'] as const;

export function supportsCriticalFunction(criticality: string): boolean {
    return (CRITICAL_FUNCTION_CRITICALITIES as readonly string[]).includes(criticality);
}
