/**
 * #5313 item 11 — the risk-appetite PUT body carries no approval. The approval
 * is `POST …/risk-appetite/approve`, which stamps the caller; a save that named
 * an approver used to store it verbatim.
 */
import { RiskAppetiteConfigSchema } from '@/app-layer/schemas/risk-appetite.schemas';

describe('RiskAppetiteConfigSchema', () => {
    it('accepts the fields the page saves', () => {
        expect(RiskAppetiteConfigSchema.safeParse({
            totalAleThreshold: 1_000_000,
            singleRiskAleMax: null,
            qualScoreMax: 15,
            testedPercentile: 80,
            appetiteStatement: 'We accept moderate risk.',
            reviewCadence: 'ANNUALLY',
            categoryOverridesJson: null,
            nextReviewAt: null,
        }).success).toBe(true);
    });

    it.each([
        ['approvedByUserId', { approvedByUserId: 'someone-else' }],
        ['approvedAt', { approvedAt: '2026-01-01T00:00:00Z' }],
    ])('refuses a body naming %s', (_field, extra) => {
        const result = RiskAppetiteConfigSchema.safeParse({ appetiteStatement: 'x', ...extra });
        expect(result.success).toBe(false);
    });
});
