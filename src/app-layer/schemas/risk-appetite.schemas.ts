/**
 * Request body of `PUT /api/t/:slug/risk-appetite`.
 *
 * `.strict()`: the approval is not part of a save (#5313 item 11, owner
 * decision 2026-11-15). `approvedByUserId` and `approvedAt` are stamped only by
 * `POST …/risk-appetite/approve`, from the caller's own identity, so a body
 * naming either is a 400 rather than a value quietly stored or quietly dropped.
 */
import { z } from 'zod';

const num = z.number().finite().nullable().optional();

export const RiskAppetiteConfigSchema = z.object({
    totalAleThreshold: num,
    singleRiskAleMax: num,
    qualScoreMax: z.number().int().nullable().optional(),
    /** RQ3-3 — which simulated percentile the ceiling is tested at. */
    testedPercentile: z
        .union([z.literal(50), z.literal(80), z.literal(90), z.literal(95), z.literal(99)])
        .optional(),
    categoryOverridesJson: z
        .record(z.string(), z.object({
            totalAleMax: z.number().optional(),
            singleAleMax: z.number().optional(),
            qualScoreMax: z.number().optional(),
        }))
        .nullable()
        .optional(),
    appetiteStatement: z.string().max(5000).nullable().optional(),
    reviewCadence: z.enum(['MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY']).optional(),
    nextReviewAt: z.string().nullable().optional(),
}).strict();

export type RiskAppetiteConfigInput = z.infer<typeof RiskAppetiteConfigSchema>;

/**
 * Request body of `POST /api/t/:slug/risk-appetite/approve` (#5313 item 11,
 * owner decision 2026-11-15: an approval is bound to the version the approver
 * was shown).
 *
 * The id and `updatedAt` of the stored configuration as the page loaded it.
 * The usecase stamps the approval in ONE conditional write naming both, so a
 * save made after the page loaded matches nothing and the approval is refused
 * (409, `RISK_APPETITE_CHANGED_SINCE_VIEWED`) rather than landing on limits
 * the approver never saw. `.strict()`, and both fields required: an approval
 * that names no version is a 400, never an approval of whatever is stored.
 */
export const ApproveRiskAppetiteSchema = z.object({
    configId: z.string().min(1),
    /** `RiskAppetiteConfig.updatedAt`, as an ISO-8601 UTC string. */
    viewedUpdatedAt: z.string().datetime(),
}).strict();

export type ApproveRiskAppetiteInput = z.infer<typeof ApproveRiskAppetiteSchema>;
