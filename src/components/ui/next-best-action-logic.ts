/**
 * Pure priority-chain resolution for `<NextBestActionCard>` (v2-PR-11).
 *
 * Lives in its own React-free module so guard tests can import it
 * without dragging in CVA / Dub utils / next/link via the
 * containing component file.
 *
 * The chain order IS the contract — see
 * `tests/guards/next-best-action-discipline.test.ts`.
 *
 * The module returns no English. The card renders each action's label and
 * description from `dashboard.nextAction.<messageKey>` in the reader's
 * language, with `count` as the number the description quotes.
 *
 * Every `href` names filters its target page actually reads (its filter-defs
 * keys): `?filter=` was read by no page, so all three links used to open the
 * whole unfiltered list.
 */
export interface NextBestActionInput {
    /** % of applicable controls implemented (0–100). */
    coveragePercent: number;
    /** Number of evidence rows past their next-review date. */
    overdueEvidence: number;
    /** Number of tasks past dueAt with non-terminal status. */
    overdueTasks: number;
    /** Number of OPEN risks with inherent score ≥ 10 (high or critical). */
    highRisks: number;
}

export interface NextBestAction {
    /** Stable id used by the ratchet to assert priority order. */
    id:
        | "overdue-evidence"
        | "overdue-tasks"
        | "high-risks"
        | "low-coverage"
        | "readiness-check";
    /** The `dashboard.nextAction.*` message group for this action. */
    messageKey:
        | "overdueEvidence"
        | "overdueTasks"
        | "highRisks"
        | "lowCoverage"
        | "readinessCheck";
    /** The number the description quotes (a count, or coverage %). */
    count: number;
    href: string;
}

/**
 * The Risks list filter for the population `highRisks` counts: risks still
 * needing treatment (Open or Mitigating; not mitigated, accepted or closed)
 * with an inherent score of 10 or more.
 *
 * Spelled out rather than imported from `app-layer/domain/risk-status`,
 * because this module sits in the shared UI tree, which takes no domain
 * imports (`tests/guards/shared-ui-coupling-ratchet.test.ts`).
 * `tests/guards/next-best-action-discipline.test.ts` builds the expected href
 * FROM that module's `HIGH_RISK_SCORE_MIN` and `NEEDS_TREATMENT_RISK_STATUSES`,
 * so the two cannot drift apart unnoticed.
 */
const HIGH_RISKS_NEEDING_TREATMENT_QUERY = "score=10|25&status=OPEN,MITIGATING";

export function resolveNextBestAction(
    input: NextBestActionInput,
    tenantHref: (path: string) => string,
): NextBestAction {
    if (input.overdueEvidence > 0) {
        return {
            id: "overdue-evidence",
            messageKey: "overdueEvidence",
            count: input.overdueEvidence,
            // The Evidence page's freshness bucket for a row past its
            // review date.
            href: tenantHref("/evidence?freshness=expired"),
        };
    }
    if (input.overdueTasks > 0) {
        return {
            id: "overdue-tasks",
            messageKey: "overdueTasks",
            count: input.overdueTasks,
            // The Tasks page's due chip: past dueAt, not terminal — the same
            // predicate the count uses.
            href: tenantHref("/tasks?due=overdue"),
        };
    }
    if (input.highRisks > 0) {
        return {
            id: "high-risks",
            messageKey: "highRisks",
            count: input.highRisks,
            // The same score-10-and-up population, still needing
            // treatment, that the count is of.
            href: tenantHref(`/risks?${HIGH_RISKS_NEEDING_TREATMENT_QUERY}`),
        };
    }
    if (input.coveragePercent < 80) {
        return {
            id: "low-coverage",
            messageKey: "lowCoverage",
            count: Math.round(input.coveragePercent),
            href: tenantHref("/clauses"),
        };
    }
    return {
        id: "readiness-check",
        messageKey: "readinessCheck",
        count: 0,
        href: tenantHref("/audits/readiness"),
    };
}
