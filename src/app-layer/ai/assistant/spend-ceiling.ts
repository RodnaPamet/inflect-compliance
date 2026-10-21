/**
 * How much the assistant can cost, in tokens, worst case.
 *
 * ═══ WHY THIS MODULE EXISTS ═══
 *
 * #3833 asked whether assistant spend should be metered against the tenant
 * monthly budget, or justified not. It was justified not, for a good reason:
 * folding it into `agentMonthlyTokenBudget` would silently redefine a setting
 * tenants have already configured, so an agent budget would start refusing
 * agent runs because a human used the assistant.
 *
 * The justification then names a replacement bound — the daily quota in
 * `checkRateLimit`, which governs this path from `runGoverned` and therefore
 * covers BOTH `askAssistant` and `streamAssistant`. That argument is sound.
 *
 * What it did not say was how large the bound is (#3918), and "bounded" without
 * a magnitude reads as "safe" when it only means "finite". The ceiling is tens
 * of millions of output tokens per tenant per month.
 *
 * ═══ WHY IT IS COMPUTED AND NOT WRITTEN DOWN ═══
 *
 * A number typed into a docblock goes stale the moment one of its three inputs
 * moves, and nothing fails. These are derived from the live constants instead,
 * so raising `MAX_TOKENS`, the iteration cap or the daily quota moves the stated
 * ceiling with it. `tests/unit/ai/assistant-spend-ceiling.test.ts` pins both the
 * arithmetic and today's values, so a change is loud rather than quiet.
 *
 * ═══ WHAT THIS IS NOT ═══
 *
 * Not a limiter. Nothing reads these numbers to refuse a turn — the refusing is
 * done by `checkRateLimit` and `DEFAULT_LOOP_BOUNDS`. This module exists so the
 * size of the accepted exposure is stated somewhere a reader will find it, next
 * to the reasoning that accepted it.
 *
 * @module ai/assistant/spend-ceiling
 */
import { LIMITS } from '@/app-layer/ai/risk-assessment/rate-limiter';

import { DEFAULT_LOOP_BOUNDS } from './tool-loop';
import { MAX_TOKENS } from './turn-provider';

/**
 * Days used for the monthly figure.
 *
 * 30, not 28 or 31: the quota is a DAILY counter, so a month has no meaning to
 * the limiter at all and any monthly figure is a reader's convenience. 30 is the
 * round number that does not overstate a short month or understate a long one by
 * more than a day's worth.
 */
export const CEILING_DAYS_PER_MONTH = 30;

/**
 * Worst-case OUTPUT tokens. Input tokens are excluded deliberately: they are
 * bounded by the prompt and tool results, which `resultBytes` already caps, and
 * mixing the two into one figure would make neither checkable.
 */
export const ASSISTANT_SPEND_CEILING = {
    /** One turn: every iteration returning the maximum the provider will emit. */
    perTurnOutputTokens: MAX_TOKENS * DEFAULT_LOOP_BOUNDS.iterations,
    /** One tenant, one day: the daily quota of those turns. */
    perTenantDayOutputTokens:
        MAX_TOKENS * DEFAULT_LOOP_BOUNDS.iterations * LIMITS.TENANT_DAILY_QUOTA,
    /** One tenant, 30 days. */
    perTenantMonthOutputTokens:
        MAX_TOKENS *
        DEFAULT_LOOP_BOUNDS.iterations *
        LIMITS.TENANT_DAILY_QUOTA *
        CEILING_DAYS_PER_MONTH,
} as const;

/** The inputs, so a reader can check the arithmetic without reading three files. */
export const ASSISTANT_SPEND_CEILING_INPUTS = {
    maxTokensPerRoundTrip: MAX_TOKENS,
    iterationsPerTurn: DEFAULT_LOOP_BOUNDS.iterations,
    turnsPerTenantDay: LIMITS.TENANT_DAILY_QUOTA,
    daysPerMonth: CEILING_DAYS_PER_MONTH,
} as const;
