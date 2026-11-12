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

import {
    ASSISTANT_HISTORY_MAX_CHARS,
    ASSISTANT_QUESTION_MAX_CHARS,
    MAX_UTF8_BYTES_PER_CODE_UNIT,
} from './limits';
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
 * bounded by the prompt, the person's own text and tool results, and mixing the
 * two into one figure would make neither checkable. The person's text has its
 * own figure, `ASSISTANT_USER_INPUT_CEILING` below (#5054).
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

/**
 * The worst case of the PERSON'S OWN TEXT in one turn, in bytes (#5054).
 *
 * The output ceiling above excludes input because input was "bounded by the
 * prompt and tool results". A multi-line question and the earlier turns sent
 * with it are input the person writes, so their bound is stated here, from the
 * live constants, beside the figure it is compared with.
 *
 * Bytes, because no model token is shorter than one byte: a byte count is a
 * hard upper bound on tokens, where any chars-per-token figure is an estimate.
 *
 * The question and history are a stable prefix re-sent on every round trip,
 * so a turn pays for them once per iteration. The bound that makes that
 * acceptable: over a whole turn it equals `toolCalls × resultBytes`, the
 * tool-result bytes the loop already admits. Two invariants in
 * `tests/unit/ai/assistant-spend-ceiling.test.ts` hold it — a question is
 * never larger than one tool result, and the person's text over a turn is never
 * more than the turn's tool-result allowance — so raising either limit fails a
 * test until somebody argues the budget again.
 *
 * Not a limiter: the schema refuses an over-long request; this states the size.
 * `tokensIn` on each decision row records what a turn actually cost, history
 * included, because it is the provider's own `input_tokens`.
 */
export const ASSISTANT_USER_INPUT_CEILING = {
    /** Question plus history, in characters (UTF-16 code units). */
    charsPerRequest: ASSISTANT_QUESTION_MAX_CHARS + ASSISTANT_HISTORY_MAX_CHARS,
    /** The same, as an upper bound on UTF-8 bytes and so on tokens. */
    bytesPerRequest:
        (ASSISTANT_QUESTION_MAX_CHARS + ASSISTANT_HISTORY_MAX_CHARS) * MAX_UTF8_BYTES_PER_CODE_UNIT,
    /** Re-sent on every round trip of a turn. */
    bytesPerTurn:
        (ASSISTANT_QUESTION_MAX_CHARS + ASSISTANT_HISTORY_MAX_CHARS) *
        MAX_UTF8_BYTES_PER_CODE_UNIT *
        DEFAULT_LOOP_BOUNDS.iterations,
    /** What the loop already admits from tools in one turn, for comparison. */
    toolResultBytesPerTurn: DEFAULT_LOOP_BOUNDS.toolCalls * DEFAULT_LOOP_BOUNDS.resultBytes,
    /** One tenant-day of worst-case turns: the input figure beside the output one. */
    bytesPerTenantDay:
        (ASSISTANT_QUESTION_MAX_CHARS + ASSISTANT_HISTORY_MAX_CHARS) *
        MAX_UTF8_BYTES_PER_CODE_UNIT *
        DEFAULT_LOOP_BOUNDS.iterations *
        LIMITS.TENANT_DAILY_QUOTA,
} as const;
