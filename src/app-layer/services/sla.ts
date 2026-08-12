/**
 * SLA computation service.
 * Pure functions — no DB, no side effects. Derives triage/resolve deadlines from severity + createdAt.
 */
import { isTerminalStatus } from '../domain/task-status';

export interface SLADates {
    triageDueAt: Date | null;
    resolveDueAt: Date | null;
}

/**
 * SLA windows per severity (in hours).
 * INFO issues have no SLA.
 */
const SLA_WINDOWS: Record<string, { triageHours: number | null; resolveHours: number | null }> = {
    CRITICAL: { triageHours: 4, resolveHours: 24 },
    HIGH: { triageHours: 24, resolveHours: 72 },
    MEDIUM: { triageHours: 72, resolveHours: 168 },      // 7 days
    LOW: { triageHours: 168, resolveHours: 720 },         // 30 days
    INFO: { triageHours: null, resolveHours: null },
};

/**
 * Compute SLA deadline dates from severity and creation time.
 */
export function computeSLADates(severity: string, createdAt: Date | string): SLADates {
    const created = typeof createdAt === 'string' ? new Date(createdAt) : createdAt;
    const windows = SLA_WINDOWS[severity] || SLA_WINDOWS.INFO;

    return {
        triageDueAt: windows.triageHours != null
            ? new Date(created.getTime() + windows.triageHours * 60 * 60 * 1000)
            : null,
        resolveDueAt: windows.resolveHours != null
            ? new Date(created.getTime() + windows.resolveHours * 60 * 60 * 1000)
            : null,
    };
}

/**
 * Check whether an SLA deadline has been breached.
 */
export function isSlaBreach(slaDueAt: Date | string | null, now?: Date): boolean {
    if (!slaDueAt) return false;
    const deadline = typeof slaDueAt === 'string' ? new Date(slaDueAt) : slaDueAt;
    return (now || new Date()) > deadline;
}

/**
 * Get a human-readable SLA status label.
 */
export function getSlaStatus(
    severity: string,
    createdAt: Date | string,
    currentStatus: string,
    now?: Date,
): { triageBreach: boolean; resolveBreach: boolean; label: string } {
    const sla = computeSLADates(severity, createdAt);
    const effectiveNow = now || new Date();

    // Resolved/Closed/Canceled issues don't breach
    if (isTerminalStatus(currentStatus)) {
        return { triageBreach: false, resolveBreach: false, label: '' };
    }

    const triageBreach = ['OPEN'].includes(currentStatus) && isSlaBreach(sla.triageDueAt, effectiveNow);
    const resolveBreach = isSlaBreach(sla.resolveDueAt, effectiveNow);

    if (resolveBreach) return { triageBreach, resolveBreach, label: 'SLA Breached' };
    if (triageBreach) return { triageBreach, resolveBreach, label: 'Triage SLA Breached' };
    return { triageBreach, resolveBreach, label: '' };
}
