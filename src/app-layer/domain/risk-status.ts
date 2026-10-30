/**
 * Risk status groupings — which risks are still OPEN, and which still NEED
 * TREATMENT. Two lines, drawn for two different questions.
 *
 * OPEN: a risk stops being open when it is CLOSED or ACCEPTED: closed, the
 * work is done; accepted, somebody signed off on living with it. Every other
 * status — OPEN, MITIGATING and MITIGATED (controls in place, awaiting the
 * acceptance call) — is a risk somebody still owns. That is the line for
 * "is anything still due on this risk": the deadline monitor's risk-review
 * scan and the compliance calendar's risk loader use it, because a mitigated
 * risk still has a review date and an acceptance decision to come.
 *
 * NEEDS TREATMENT: OPEN and MITIGATING only. A MITIGATED risk has had its
 * treatment; what is left is a sign-off, not work on the risk itself. That is
 * the line for "how much risk is still exposed": the Board's severity figures
 * use it (owner decision, 2026-10-30), as the daily risk snapshot's open count
 * and the automation suggestions' active-risk count already did inline.
 *
 * Every list here is DERIVED from one exhaustive map keyed on the Prisma enum,
 * so a status added to `RiskStatus` fails `tsc` here until somebody places it,
 * rather than falling silently into none of the lists.
 *
 * Pure: no Prisma client, no server imports, so a client component can import
 * it (the dashboard's drill links name the statuses in a URL).
 *
 * @module app-layer/domain/risk-status
 */
import type { RiskStatus } from '@prisma/client';

/**
 * Where each status sits in a risk's life.
 *
 *   needsTreatment     — OPEN, MITIGATING: exposed, treatment not finished
 *   awaitingAcceptance — MITIGATED: treated, the acceptance call still due
 *   settled            — ACCEPTED, CLOSED: nothing further due
 */
const RISK_STATUS_STAGE = {
    OPEN: 'needsTreatment',
    MITIGATING: 'needsTreatment',
    MITIGATED: 'awaitingAcceptance',
    ACCEPTED: 'settled',
    CLOSED: 'settled',
} as const satisfies Record<RiskStatus, 'needsTreatment' | 'awaitingAcceptance' | 'settled'>;

const ALL_RISK_STATUSES = Object.keys(RISK_STATUS_STAGE) as RiskStatus[];

/** Statuses of a risk that is no longer open: closed, or accepted. */
export const SETTLED_RISK_STATUSES: readonly RiskStatus[] = ALL_RISK_STATUSES.filter(
    (s) => RISK_STATUS_STAGE[s] === 'settled',
);

/** Statuses of a risk that is still open. The complement of the above. */
export const OPEN_RISK_STATUSES: readonly RiskStatus[] = ALL_RISK_STATUSES.filter(
    (s) => RISK_STATUS_STAGE[s] !== 'settled',
);

/**
 * Statuses of a risk that still needs treatment: OPEN and MITIGATING. The open
 * statuses without MITIGATED. See the module header for why the two differ.
 */
export const NEEDS_TREATMENT_RISK_STATUSES: readonly RiskStatus[] = ALL_RISK_STATUSES.filter(
    (s) => RISK_STATUS_STAGE[s] === 'needsTreatment',
);

/** True for CLOSED and ACCEPTED. Accepts a plain string for read models. */
export function isSettledRiskStatus(status: string): boolean {
    return (SETTLED_RISK_STATUSES as readonly string[]).includes(status);
}

/** True for OPEN and MITIGATING. Accepts a plain string for read models. */
export function riskStatusNeedsTreatment(status: string): boolean {
    return (NEEDS_TREATMENT_RISK_STATUSES as readonly string[]).includes(status);
}

/** Prisma `status` filter selecting open risks only. */
export function openRiskStatusFilter(): { notIn: RiskStatus[] } {
    return { notIn: [...SETTLED_RISK_STATUSES] };
}

/** Prisma `status` filter selecting the risks that still need treatment. */
export function needsTreatmentRiskStatusFilter(): { in: RiskStatus[] } {
    return { in: [...NEEDS_TREATMENT_RISK_STATUSES] };
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
