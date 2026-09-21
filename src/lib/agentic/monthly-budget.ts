/**
 * The tenant's MONTHLY token budget, enforced before a run starts.
 *
 * ## Why pre-flight rather than mid-flight
 *
 * `run-caps.ts` already bounds a SINGLE run — steps, tool calls, proposals,
 * tokens, wall clock — and halts it at the boundary. That is the right shape
 * for one run and the wrong shape for a month: a tenant can stay inside every
 * per-run cap and still spend without limit by starting runs, because nothing
 * accumulates across them.
 *
 * So this axis is checked ONCE, at the door, and never again during the run.
 * Truncating a run mid-flight because a monthly total tipped over is the worst
 * of both: the tokens are already spent, the work is half-done, and the partial
 * state is exactly what `WorkflowRun`'s context chain exists to avoid.
 *
 * ## "Would exceed" is answerable, and this is how
 *
 * A run's eventual cost is unknown at the door — but its MAXIMUM is not. The
 * run's own `TOKENS` cap (from `resolveRunCaps`, engine ceiling narrowed by the
 * policy card) is a hard upper bound the run cannot cross without halting. So:
 *
 *     spentThisMonth + thisRunsTokenCap > budget   ⟹   refuse
 *
 * This refuses a run that COULD exceed the budget, not one that WILL. That is
 * the conservative direction and it is deliberate: the alternative — admit the
 * run and stop when the total actually tips — is mid-flight truncation by
 * another name.
 *
 * It follows that a tenant whose budget is smaller than a single run's token
 * cap can never start a run at all. That is a correct refusal, reported with
 * both numbers so an operator can see immediately that the budget, not the
 * usage, is what needs changing.
 *
 * ## NULL means NO BUDGET CONFIGURED, and that is unlimited
 *
 * The fail-closed reflex is wrong here and the reason is worth stating. Every
 * other absence in this subsystem guards an AUTHORITY — may this agent act, may
 * it reach this tool — and there the safe end of the switch is "no". A budget
 * is a LIMIT on something already authorised. Reading its absence as zero would
 * refuse every run for every tenant on the day this ships, which is an outage
 * wearing the costume of a control.
 *
 * So `null` is unlimited, exactly as `PLAN_LIMITS` in `lib/billing/entitlements.ts`
 * uses `null`, and the feature is opt-in by configuration. A tenant that wants
 * the control sets a number.
 */

/** Why a run was refused at the door. */
export type MonthlyBudgetRefusal = 'MONTHLY_TOKEN_BUDGET_EXCEEDED';

export interface MonthlyBudgetTerms {
    /**
     * The tenant's configured ceiling, or `null` for "no budget configured".
     * A NEGATIVE number is treated as zero rather than as unlimited — see
     * `normaliseBudget`.
     */
    readonly budgetTokens: number | null | undefined;
    /** Tokens already charged to this tenant's runs in the current UTC month. */
    readonly spentThisMonth: number;
    /**
     * The HARD upper bound on what the run being admitted can spend — its
     * resolved `TOKENS` cap. Not an estimate, and not the average: the run
     * halts at this number, so it is the only figure that makes "would exceed"
     * a statement rather than a guess.
     */
    readonly runTokenCap: number;
}

export interface MonthlyBudgetVerdict {
    readonly allowed: boolean;
    readonly reason: MonthlyBudgetRefusal | null;
    /** Every number the decision used, so a refusal explains itself. */
    readonly budgetTokens: number | null;
    readonly spentThisMonth: number;
    readonly runTokenCap: number;
    /** `spentThisMonth + runTokenCap` — the figure compared against the budget. */
    readonly worstCaseTotal: number;
}

/**
 * Coerce a stored budget to a usable number.
 *
 * A negative budget is nonsense that the column's CHECK refuses, but a value
 * can still arrive from an older build or a hand-edited row. It reads as ZERO
 * (refuse everything) rather than as unlimited: for a LIMIT, the surprising
 * value must not be the permissive one, or a typo becomes a bypass.
 */
function normaliseBudget(raw: number | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    if (!Number.isFinite(raw)) return null;
    return raw < 0 ? 0 : Math.floor(raw);
}

/**
 * Decide whether one run may start. Pure, total, never throws.
 */
export function evaluateMonthlyBudget(terms: MonthlyBudgetTerms): MonthlyBudgetVerdict {
    const budgetTokens = normaliseBudget(terms.budgetTokens);
    const spentThisMonth = Math.max(0, Math.floor(terms.spentThisMonth || 0));
    const runTokenCap = Math.max(0, Math.floor(terms.runTokenCap || 0));
    const worstCaseTotal = spentThisMonth + runTokenCap;

    const base = { budgetTokens, spentThisMonth, runTokenCap, worstCaseTotal };

    // No budget configured — the feature is off for this tenant.
    if (budgetTokens === null) {
        return { ...base, allowed: true, reason: null };
    }

    // STRICTLY GREATER, not >=. A run whose worst case lands exactly on the
    // budget has not exceeded it, and refusing it would make the configured
    // number mean one token less than it says.
    if (worstCaseTotal > budgetTokens) {
        return { ...base, allowed: false, reason: 'MONTHLY_TOKEN_BUDGET_EXCEEDED' };
    }

    return { ...base, allowed: true, reason: null };
}

/**
 * The inclusive start of the UTC calendar month containing `now`.
 *
 * UTC rather than the tenant's local zone, and that is a decision rather than a
 * default: `WorkflowRun.startedAt` is stored in UTC, the sum has to agree with
 * the column it reads, and a tenant-local month boundary would make the same
 * run fall inside or outside the window depending on which server answered.
 * The cost is that a tenant in UTC+13 sees its budget reset partway through its
 * own first day of the month; the benefit is that the number is the same
 * wherever it is computed.
 *
 * Takes the clock as an argument so the boundary is testable without freezing
 * global time.
 */
export function monthStartUtc(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * The refusal message, with both numbers in it.
 *
 * A refusal that says only "budget exceeded" leaves an operator guessing
 * between "this tenant is using too much" and "this budget is set below one
 * run's ceiling" — and the second is a configuration mistake that no amount of
 * reduced usage will clear. Both figures appear so the two are distinguishable
 * on sight.
 */
export function monthlyBudgetRefusalMessage(verdict: MonthlyBudgetVerdict): string {
    return (
        `monthly_token_budget_exceeded: this run's ceiling of ${verdict.runTokenCap} tokens ` +
        `on top of ${verdict.spentThisMonth} already spent this month would reach ` +
        `${verdict.worstCaseTotal}, above the configured budget of ${verdict.budgetTokens}`
    );
}
