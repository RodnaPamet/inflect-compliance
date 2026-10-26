/**
 * The plan-limit refusal's two ends — what `assertWithinLimit` throws and
 * what a client recognises — come from one module, so they cannot drift.
 */
import {
    formatPlanLimitMessage,
    parsePlanLimitMessage,
} from '@/lib/billing/plan-limit-message';

describe('plan-limit message', () => {
    it('round-trips through format → parse', () => {
        const refusal = { plan: 'FREE', resource: 'control', limit: 10, current: 12 };
        expect(parsePlanLimitMessage(formatPlanLimitMessage(refusal))).toEqual(refusal);
    });

    it('keeps the wire format the server has always sent', () => {
        // Billing tooling and logs key on this exact sentence.
        expect(
            formatPlanLimitMessage({ plan: 'FREE', resource: 'control', limit: 10, current: 10 }),
        ).toBe(
            'plan_limit_exceeded: FREE plan allows 10 control(s); tenant currently has 10. Upgrade to add more.',
        );
    });

    it('is null for anything that is not a plan-limit refusal', () => {
        expect(parsePlanLimitMessage(undefined)).toBeNull();
        expect(parsePlanLimitMessage('')).toBeNull();
        expect(parsePlanLimitMessage('A control with code AC-1 already exists.')).toBeNull();
        // The prefix alone, without the structured body, is not parseable.
        expect(parsePlanLimitMessage('plan_limit_exceeded: control')).toBeNull();
    });
});
