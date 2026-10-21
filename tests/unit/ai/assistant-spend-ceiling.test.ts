/**
 * The stated size of the assistant's accepted spend exposure (#3918).
 *
 * #3833 declined to meter assistant spend against `agentMonthlyTokenBudget` and
 * justified it with a derived bound. The justification was sound and the
 * magnitude was nowhere — so a reader met the word "bounded" with no way to tell
 * whether that meant thousands of tokens or tens of millions.
 *
 * This suite does two different jobs, and the second is the one that keeps the
 * first honest:
 *
 *   1. The ARITHMETIC — the ceiling really is the product of its inputs. This
 *      can never go stale, because both sides are computed.
 *   2. The VALUES — today's numbers, pinned. This one CAN go stale, and that is
 *      its purpose: raising `MAX_TOKENS`, the loop's iteration cap or the tenant
 *      daily quota fails here, which is the moment someone should decide whether
 *      the larger exposure is still acceptable rather than discovering it later.
 *
 * Test 1 alone would pass under any constants at all, which is exactly the shape
 * of a check that cannot express the failure it exists to catch.
 */
import {
    ASSISTANT_SPEND_CEILING,
    ASSISTANT_SPEND_CEILING_INPUTS,
    CEILING_DAYS_PER_MONTH,
} from '@/app-layer/ai/assistant/spend-ceiling';
import { DEFAULT_LOOP_BOUNDS } from '@/app-layer/ai/assistant/tool-loop';
import { MAX_TOKENS } from '@/app-layer/ai/assistant/turn-provider';
import { LIMITS } from '@/app-layer/ai/risk-assessment/rate-limiter';

describe('the ceiling is the product of its inputs', () => {
    it('reports the inputs it used, and they are the LIVE constants', () => {
        // Not a restatement: if `spend-ceiling.ts` ever hard-coded a number
        // instead of importing, these would diverge and the arithmetic test
        // below would still pass.
        expect(ASSISTANT_SPEND_CEILING_INPUTS).toEqual({
            maxTokensPerRoundTrip: MAX_TOKENS,
            iterationsPerTurn: DEFAULT_LOOP_BOUNDS.iterations,
            turnsPerTenantDay: LIMITS.TENANT_DAILY_QUOTA,
            daysPerMonth: CEILING_DAYS_PER_MONTH,
        });
    });

    it('a turn is max_tokens times the iteration cap', () => {
        expect(ASSISTANT_SPEND_CEILING.perTurnOutputTokens).toBe(
            MAX_TOKENS * DEFAULT_LOOP_BOUNDS.iterations,
        );
    });

    it('a tenant-day is that times the daily quota', () => {
        expect(ASSISTANT_SPEND_CEILING.perTenantDayOutputTokens).toBe(
            ASSISTANT_SPEND_CEILING.perTurnOutputTokens * LIMITS.TENANT_DAILY_QUOTA,
        );
    });

    it('a tenant-month is that times 30 days', () => {
        expect(ASSISTANT_SPEND_CEILING.perTenantMonthOutputTokens).toBe(
            ASSISTANT_SPEND_CEILING.perTenantDayOutputTokens * CEILING_DAYS_PER_MONTH,
        );
    });
});

describe("today's values, pinned so a constant change is a decision", () => {
    /*
        WHEN THIS FAILS, DO NOT JUST RE-SEAT IT.

        A failure here means the accepted exposure grew. The question to answer
        in the same diff is whether the new figure is still acceptable without a
        ceiling that refuses — which is the judgement #3833 made against the OLD
        numbers. Update these values and the docblock in
        `usecases/assistant.ts` together, and say in the commit what the new
        exposure is.
    */
    it('max_tokens 8192, 6 iterations, 50 turns a tenant-day', () => {
        expect(MAX_TOKENS).toBe(8192);
        expect(DEFAULT_LOOP_BOUNDS.iterations).toBe(6);
        expect(LIMITS.TENANT_DAILY_QUOTA).toBe(50);
    });

    it('the ceilings those produce', () => {
        expect(ASSISTANT_SPEND_CEILING.perTurnOutputTokens).toBe(49_152);
        expect(ASSISTANT_SPEND_CEILING.perTenantDayOutputTokens).toBe(2_457_600);
        expect(ASSISTANT_SPEND_CEILING.perTenantMonthOutputTokens).toBe(73_728_000);
    });

    it('the docblock in usecases/assistant.ts states the same order of magnitude', () => {
        // Deliberately an ORDER-OF-MAGNITUDE check against the prose, not a
        // string match on "~49k". The docblock rounds for readability, so an
        // exact comparison would fail on a wording change that is not a defect;
        // what must not happen is prose claiming thousands while the constants
        // permit millions.
        const month = ASSISTANT_SPEND_CEILING.perTenantMonthOutputTokens;
        expect(month).toBeGreaterThan(10_000_000);
        expect(month).toBeLessThan(1_000_000_000);
    });
});
