/**
 * The per-tenant cap on CONCURRENT agentic runs — the pure half (#3484).
 *
 * ## Why this is a second axis and not a second spelling of the budget
 *
 * `agentMonthlyTokenBudget` bounds SPEND OVER A MONTH. Nothing bounded
 * SIMULTANEITY, so a tenant well inside its budget could start runs until the
 * BullMQ worker pool was the limit — and the pool is shared across tenants,
 * which makes one tenant's burst everybody else's queue depth. A monthly
 * budget cannot express that: ten runs at once and ten runs over ten hours
 * cost the same tokens.
 *
 * ## No database here, deliberately
 *
 * The same split `monthly-budget.ts` / `monthly-budget-policy.ts` carries, and
 * for the same reason: the decision is worth testing without a database. The
 * server half is `run-concurrency-policy.ts`.
 *
 * ## Zero is a value, not an absence
 *
 * `cap: null` means no cap — the state every tenant is in until somebody sets
 * one. `cap: 0` means NO AGENTIC RUN MAY START, which is a readable way to
 * stop a tenant's agents without engaging a kill switch. Collapsing the two
 * with `cap || null` is the bug this file is written to make impossible, and
 * `normaliseCap` keeps them apart.
 */

/**
 * The statuses a run can still PROGRESS from.
 *
 * ONE definition, and it has two readers that must not disagree: this cap
 * counts them, and the replay tail (#3472) keeps an SSE connection open on
 * exactly the same question — can this run still produce steps? Two lists
 * would drift invisibly, and the drift would show up as a tenant refused for
 * a run nobody was watching progress, or a stream held open for a run that
 * had finished.
 *
 * The terminal statuses are deliberately absent: a cap that counted them would
 * refuse a tenant for work that was already over. As of #3869 they are
 * `COMPLETED`, `ABORTED`, `FAILED` and `EMPTY_CATALOGUE` — but do not read a
 * count off this comment, because that is exactly what rotted. It used to say
 * "those three plus these three are the WHOLE of `WorkflowRunStatus`", which a
 * single added value falsified.
 *
 * What holds instead is the SHAPE: this is an allowlist of the LIVE statuses,
 * so a status added to the enum and not taught here is excluded, and `a cap
 * that counted it` cannot happen. That is the safe direction, and it is not
 * universal — `a2a-synchronous-wait.ts` allowlisted the TERMINAL side until
 * #3869 and had the opposite failure, reporting a finished run as unsettled.
 * Two tests hold both directions: this list is a subset of the generated enum,
 * and its complement is exactly the terminal set, so a new value fails there
 * and gets classified on purpose. There is still no `PENDING` and no `HALTED`,
 * however much either sounds like one.
 */
export const LIVE_RUN_STATUSES = [
    'RUNNING',
    'AWAITING_APPROVAL',
    'PAUSED',
] as const;

export type LiveRunStatus = (typeof LIVE_RUN_STATUSES)[number];

const LIVE_SET: ReadonlySet<string> = new Set<string>(LIVE_RUN_STATUSES);

/** Can this run still produce steps? Fails CLOSED on an unknown status. */
export function isLiveRunStatus(status: string): boolean {
    return LIVE_SET.has(status);
}

export interface ConcurrencyVerdict {
    allowed: boolean;
    /** The configured cap, or null when none is set. */
    cap: number | null;
    /** How many of this tenant's runs can still progress. */
    inFlight: number;
    /** `cap - inFlight`, floored at 0; null when there is no cap. */
    headroom: number | null;
}

/**
 * A stored cap, made safe to compare against.
 *
 * A negative value is refused by a CHECK constraint at the database, so this
 * should never see one. It floors rather than throwing anyway, in the SAFE
 * direction: a cap of -1 read as 0 refuses runs loudly, where reading it as
 * "unlimited" would turn a typo into a bypass. The same argument the budget
 * column's migration makes about its own constraint.
 */
export function normaliseCap(cap: number | null | undefined): number | null {
    if (cap === null || cap === undefined) return null;
    if (!Number.isFinite(cap)) return null;
    return Math.max(0, Math.floor(cap));
}

/**
 * Does the cap admit ONE MORE run?
 *
 * `inFlight` is the count of runs that can still progress — deliberately not
 * "runs started", because a cap that counted terminal runs would refuse a
 * tenant for work that finished. Strictly `<`: a tenant with a cap of 3 and 3
 * runs in flight is AT the cap, and admitting a fourth is what the cap exists
 * to prevent.
 */
export function evaluateConcurrency(input: {
    cap: number | null | undefined;
    inFlight: number;
}): ConcurrencyVerdict {
    const cap = normaliseCap(input.cap);
    const inFlight = Math.max(0, Math.floor(input.inFlight));
    if (cap === null) {
        return { allowed: true, cap: null, inFlight, headroom: null };
    }
    return {
        allowed: inFlight < cap,
        cap,
        inFlight,
        headroom: Math.max(0, cap - inFlight),
    };
}

/**
 * What an operator is told when the cap refuses a run.
 *
 * Names the cap, the count and WHO CAN CHANGE IT, because "try again later" is
 * not actionable and this refusal has two legitimate answers: wait, or raise
 * the cap. It says nothing about the other runs — which workflows they are and
 * who started them is tenant content, and this message travels in an error
 * body.
 */
export function concurrencyRefusalMessage(verdict: ConcurrencyVerdict): string {
    if (verdict.cap === 0) {
        return (
            'Agentic runs are disabled for this tenant: the concurrent-run cap ' +
            'is set to 0. A tenant administrator can raise it on the Agents ' +
            'page. (This is a cap, not a kill switch — a kill switch would also ' +
            'stop tool calls inside runs that are already going.)'
        );
    }
    return (
        `This tenant already has ${verdict.inFlight} agentic run(s) in flight ` +
        `and its cap is ${verdict.cap}. Wait for one to finish, or ask a tenant ` +
        'administrator to raise the cap on the Agents page.'
    );
}
