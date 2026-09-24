/**
 * The monthly token budget — the one cap in this subsystem that spans runs.
 *
 * ── WHAT MAKES THIS WORTH TESTING ───────────────────────────────────────────
 *
 * Every other cap bounds a single run and halts it at the boundary. This one
 * decides whether a run starts at all, from three numbers, and each of the
 * three has a wrong reading that is easy to ship:
 *
 *   · an absent budget read as ZERO rather than unlimited — which would refuse
 *     every run for every tenant on the day it ships;
 *   · a NEGATIVE budget read as unlimited rather than zero — a typo becoming a
 *     bypass on a column whose whole job is to limit;
 *   · `>=` instead of `>` — making the configured number mean one token less
 *     than it says.
 *
 * All three are asserted below, in both directions.
 */
import {
    evaluateMonthlyBudget,
    monthStartUtc,
    monthlyBudgetRefusalMessage,
} from '@/lib/agentic/monthly-budget';
import { ENGINE_RUN_CAPS, resolveRunCaps } from '@/lib/agentic/run-caps';

describe('an absent budget is unlimited, not zero', () => {
    it.each([null, undefined])('admits any run when the budget is %p', (budgetTokens) => {
        const v = evaluateMonthlyBudget({
            budgetTokens,
            spentThisMonth: 10_000_000,
            runTokenCap: 10_000_000,
        });
        expect({ allowed: v.allowed, reason: v.reason }).toEqual({ allowed: true, reason: null });
    });

    it('reports the numbers even when it allows', () => {
        // A verdict that only says "yes" cannot feed a headroom display, and
        // the operator surface this is destined for needs the figures whether
        // or not the run was refused.
        const v = evaluateMonthlyBudget({
            budgetTokens: 500,
            spentThisMonth: 100,
            runTokenCap: 50,
        });
        expect(v).toEqual({
            allowed: true,
            reason: null,
            budgetTokens: 500,
            spentThisMonth: 100,
            runTokenCap: 50,
            worstCaseTotal: 150,
        });
    });
});

describe('a negative budget is zero, not unlimited', () => {
    it('refuses everything at -1 rather than admitting everything', () => {
        // The direction that matters. A limit whose surprising value is the
        // PERMISSIVE one is how a typo becomes a bypass.
        const v = evaluateMonthlyBudget({
            budgetTokens: -1,
            spentThisMonth: 0,
            runTokenCap: 1,
        });
        expect({ allowed: v.allowed, budgetTokens: v.budgetTokens }).toEqual({
            allowed: false,
            budgetTokens: 0,
        });
    });

    it('refuses a run of any size against a zero budget', () => {
        expect(
            evaluateMonthlyBudget({ budgetTokens: 0, spentThisMonth: 0, runTokenCap: 1 }).allowed,
        ).toBe(false);
        // ...but a zero-cost run against a zero budget is not an excess.
        expect(
            evaluateMonthlyBudget({ budgetTokens: 0, spentThisMonth: 0, runTokenCap: 0 }).allowed,
        ).toBe(true);
    });
});

describe('the boundary is strictly greater-than', () => {
    it('admits a worst case that lands EXACTLY on the budget', () => {
        // 400 spent + a 100-token ceiling = exactly 500. That has not exceeded
        // 500, and refusing it would make the configured number mean 499.
        const v = evaluateMonthlyBudget({
            budgetTokens: 500,
            spentThisMonth: 400,
            runTokenCap: 100,
        });
        expect({ allowed: v.allowed, worstCaseTotal: v.worstCaseTotal }).toEqual({
            allowed: true,
            worstCaseTotal: 500,
        });
    });

    it('refuses one token past it', () => {
        const v = evaluateMonthlyBudget({
            budgetTokens: 500,
            spentThisMonth: 401,
            runTokenCap: 100,
        });
        expect({ allowed: v.allowed, reason: v.reason, worstCaseTotal: v.worstCaseTotal }).toEqual({
            allowed: false,
            reason: 'MONTHLY_TOKEN_BUDGET_EXCEEDED',
            worstCaseTotal: 501,
        });
    });
});

describe('it refuses on the WORST case, not on what has been spent', () => {
    it('refuses a tenant well under budget whose next run could cross it', () => {
        // This is the whole point of pre-flight. Spend is 10 of 100 — nowhere
        // near the limit — but the run being admitted can reach 200 on its own,
        // and admitting it means either truncating mid-flight or blowing the
        // budget. Neither is acceptable, so the door is where it stops.
        const v = evaluateMonthlyBudget({
            budgetTokens: 100,
            spentThisMonth: 10,
            runTokenCap: 200,
        });
        expect(v.allowed).toBe(false);
    });

    it('a budget below one run ceiling can never admit a run, and says so with both numbers', () => {
        // A correct refusal that looks like a bug unless the message carries
        // both figures: the fix is to raise the budget, and no reduction in
        // usage will ever clear it.
        const v = evaluateMonthlyBudget({
            budgetTokens: 50,
            spentThisMonth: 0,
            runTokenCap: 200,
        });
        expect(v.allowed).toBe(false);
        const msg = monthlyBudgetRefusalMessage(v);
        expect(msg).toContain('200');
        expect(msg).toContain('50');
        expect(msg).toContain('0 already spent');
    });
});

describe('the month boundary is UTC and inclusive of its first instant', () => {
    it('starts at midnight on the 1st of the containing month', () => {
        expect(monthStartUtc(new Date('2026-09-21T13:45:06.123Z')).toISOString()).toBe(
            '2026-09-01T00:00:00.000Z',
        );
    });

    it('a timestamp already at the boundary maps to itself', () => {
        expect(monthStartUtc(new Date('2026-09-01T00:00:00.000Z')).toISOString()).toBe(
            '2026-09-01T00:00:00.000Z',
        );
    });

    it('January does not roll into the previous year', () => {
        expect(monthStartUtc(new Date('2026-01-03T00:00:00.000Z')).toISOString()).toBe(
            '2026-01-01T00:00:00.000Z',
        );
    });

    it('is computed in UTC, not the runner local zone', () => {
        // 23:30 on the 31st UTC is already the NEXT day in UTC+13. If this were
        // local-time arithmetic the answer would depend on where it ran.
        expect(monthStartUtc(new Date('2026-08-31T23:30:00.000Z')).toISOString()).toBe(
            '2026-08-01T00:00:00.000Z',
        );
    });
});

describe('the run bound the policy reads is the right one', () => {
    it('the TOKENS axis is the engine ceiling whatever the policy card says', () => {
        // THE ASSERTION THAT MAKES THE OMISSION SAFE. `monthly-budget-policy.ts`
        // uses ENGINE_RUN_CAPS.TOKENS directly and never loads the policy card,
        // on the grounds that the card cannot narrow this axis. That is true
        // today — `resolveRunCaps` returns engineCap('TOKENS') unconditionally
        // and narrows only TOOL_CALLS — and it is exactly the kind of fact that
        // stops being true without anybody noticing.
        //
        // A card at the tightest action limit expressible must still leave the
        // token ceiling alone. When that changes, this fails, and the policy
        // has to start reading the card.
        for (const maxActionsPerRun of [1, 5, 1000]) {
            expect(resolveRunCaps({ maxActionsPerRun }).TOKENS.limit).toBe(
                ENGINE_RUN_CAPS.TOKENS,
            );
        }
        expect(resolveRunCaps(null).TOKENS.limit).toBe(ENGINE_RUN_CAPS.TOKENS);
    });

    it('the engine token ceiling is a real positive number', () => {
        // A zero or absent ceiling would make every worst-case total equal the
        // spend, quietly turning the pre-flight check into a spent-so-far check
        // — the very thing this design rejects.
        expect(ENGINE_RUN_CAPS.TOKENS).toBeGreaterThan(0);
    });
});

describe('the verdict is a CHECK, not a reservation — and the bound on that', () => {
    // `spentThisMonth` is an aggregate read outside any transaction and
    // nothing claims the headroom a verdict grants, so starts that interleave
    // between the read and their first charge all see the same spend.
    //
    // Pinned as arithmetic rather than left as a comment: the exposure is
    // bounded by CONCURRENT STARTS, not by time, and a reader deciding whether
    // that matters needs the shape, not the adjective.

    it('grants the same headroom to every start that read the same spend', () => {
        // Two starts, each individually honest about its own worst case.
        const terms = { budgetTokens: 1_000, spentThisMonth: 400, runTokenCap: 500 };
        expect(evaluateMonthlyBudget(terms).allowed).toBe(true);
        expect(evaluateMonthlyBudget(terms).allowed).toBe(true);

        // 400 + 500 = 900 <= 1000 for either alone; together they can reach
        // 400 + 1000 = 1400. The overshoot is (N - 1) x runTokenCap.
        const n = 2;
        expect(terms.spentThisMonth + n * terms.runTokenCap).toBeGreaterThan(terms.budgetTokens);
        expect(terms.spentThisMonth + n * terms.runTokenCap - terms.budgetTokens).toBe(
            (n - 1) * terms.runTokenCap - (terms.budgetTokens - terms.spentThisMonth - terms.runTokenCap),
        );
    });

    it('cannot overshoot at all when starts do not overlap', () => {
        // The serial case, which is what bounds the exposure in practice: the
        // second start reads the first's charge and is refused.
        const budgetTokens = 1_000;
        const runTokenCap = 500;
        const first = evaluateMonthlyBudget({ budgetTokens, spentThisMonth: 400, runTokenCap });
        expect(first.allowed).toBe(true);

        // ...the first run then charges its cap, and the next read sees it.
        const second = evaluateMonthlyBudget({
            budgetTokens,
            spentThisMonth: 400 + runTokenCap,
            runTokenCap,
        });
        expect(second.allowed).toBe(false);
        expect(second.reason).toBe('MONTHLY_TOKEN_BUDGET_EXCEEDED');
    });
});
