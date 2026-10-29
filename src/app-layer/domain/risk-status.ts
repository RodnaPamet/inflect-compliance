/**
 * Risk status groupings — which risks are still OPEN.
 *
 * A risk stops being open when it is CLOSED or ACCEPTED: closed, the work is
 * done; accepted, somebody signed off on living with it. Every other status —
 * OPEN, MITIGATING and MITIGATED (controls in place, awaiting the acceptance
 * call) — is a risk somebody still owns. The deadline monitor's risk-review
 * scan and the compliance calendar's risk loader already drew the line there,
 * each spelling `['CLOSED', 'ACCEPTED']` inline; this module is that line,
 * named once, so the dashboard's severity figures use the same one.
 *
 * Both lists are DERIVED from one exhaustive map keyed on the Prisma enum, so a
 * status added to `RiskStatus` fails `tsc` here until somebody classifies it,
 * rather than falling silently into neither list.
 *
 * Pure: no Prisma client, no server imports, so a client component can import
 * it (the dashboard's drill links name the open statuses in a URL).
 *
 * @module app-layer/domain/risk-status
 */
import type { RiskStatus } from '@prisma/client';

const RISK_STATUS_STATE = {
    OPEN: 'open',
    MITIGATING: 'open',
    MITIGATED: 'open',
    ACCEPTED: 'settled',
    CLOSED: 'settled',
} as const satisfies Record<RiskStatus, 'open' | 'settled'>;

const ALL_RISK_STATUSES = Object.keys(RISK_STATUS_STATE) as RiskStatus[];

/** Statuses of a risk that is no longer open: closed, or accepted. */
export const SETTLED_RISK_STATUSES: readonly RiskStatus[] = ALL_RISK_STATUSES.filter(
    (s) => RISK_STATUS_STATE[s] === 'settled',
);

/** Statuses of a risk that is still open. The complement of the above. */
export const OPEN_RISK_STATUSES: readonly RiskStatus[] = ALL_RISK_STATUSES.filter(
    (s) => RISK_STATUS_STATE[s] === 'open',
);

/** True for CLOSED and ACCEPTED. Accepts a plain string for read models. */
export function isSettledRiskStatus(status: string): boolean {
    return (SETTLED_RISK_STATUSES as readonly string[]).includes(status);
}

/** Prisma `status` filter selecting open risks only. */
export function openRiskStatusFilter(): { notIn: RiskStatus[] } {
    return { notIn: [...SETTLED_RISK_STATUSES] };
}

/**
 * The lowest inherent score of a high-severity risk.
 *
 * The dashboard's Risk Distribution card bands scores as Low 1-4, Medium 5-9,
 * High 10-14 and Critical 15-25, so "high or critical" starts here. The
 * Risks card's "N high/critical" figure, the next-step card and the posture
 * radar all count from this same floor.
 */
export const HIGH_RISK_SCORE_MIN = 10;
