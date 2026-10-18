/**
 * Epic G-4 — Zod schemas for access-review usecase inputs.
 *
 * Single source of truth for both runtime validation (in the usecase)
 * and the inferred TS types every caller (API route + UI form) uses.
 *
 * Two surfaces today:
 *   • CreateAccessReviewSchema  — campaign creation payload
 *   • SubmitDecisionSchema      — discriminated union on `decision`,
 *     enforces MODIFY-needs-newRole + CONFIRM/REVOKE-forbid-newRole at
 *     parse time so the usecase never sees a malformed verdict.
 */
import { z } from 'zod';
import { AccessReviewScope } from '@prisma/client';
import { ASSIGNABLE_TENANT_ROLES } from '@/lib/roles';

const TextField = z
    .string()
    .min(1, 'must not be empty')
    .max(2000, 'too long')
    .transform((s) => s.trim());

const OptionalText = z
    .union([z.string().max(2000, 'too long').transform((s) => s.trim()), z.null()])
    .optional();

/**
 * `parseDate` accepts an ISO string OR a Date. We convert to Date so
 * the usecase never has to second-guess the wire format.
 */
const DateField = z.union([z.string().datetime(), z.date()]).transform((v) =>
    typeof v === 'string' ? new Date(v) : v,
);

// ── createAccessReview ─────────────────────────────────────────────

export const CreateAccessReviewSchema = z
    .object({
        name: TextField,
        description: OptionalText,
        scope: z.nativeEnum(AccessReviewScope).default('ALL_USERS'),
        /** Window the campaign covers — surfaces verbatim in evidence. */
        periodStartAt: DateField.optional(),
        periodEndAt: DateField.optional(),
        /** Single primary reviewer for this campaign. */
        reviewerUserId: z.string().min(1, 'reviewerUserId required'),
        /** SLA target — surfaced in the reviewer dashboard. */
        dueAt: DateField.optional(),
        /**
         * Required + non-empty when scope === 'CUSTOM'; ignored
         * otherwise. We accept membership ids (NOT user ids) so the
         * snapshot is unambiguous about *which* membership a curated
         * campaign reviews (a user could be a member of more than one
         * tenant, and we're reviewing per-tenant access).
         */
        customMembershipIds: z.array(z.string().min(1)).optional(),
    })
    .superRefine((value, ctx) => {
        if (value.scope === 'CUSTOM') {
            if (!value.customMembershipIds || value.customMembershipIds.length === 0) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                        'customMembershipIds is required and must be non-empty when scope is CUSTOM.',
                    path: ['customMembershipIds'],
                });
            }
        } else if (value.customMembershipIds && value.customMembershipIds.length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    'customMembershipIds is only valid when scope is CUSTOM.',
                path: ['customMembershipIds'],
            });
        }
        if (value.periodStartAt && value.periodEndAt && value.periodEndAt < value.periodStartAt) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'periodEndAt must not precede periodStartAt.',
                path: ['periodEndAt'],
            });
        }
    });

export type CreateAccessReviewInput = z.infer<typeof CreateAccessReviewSchema>;

// ── submitDecision ─────────────────────────────────────────────────

/**
 * Discriminated union on `decision` so MODIFY's required `modifiedToRole`
 * is enforced at parse time, and CONFIRM/REVOKE cannot smuggle role
 * fields they should not carry. The CHECK constraint on the table is
 * the storage-layer backstop; this is the application-layer guard.
 */
export const SubmitDecisionSchema = z.discriminatedUnion('decision', [
    z.object({
        decision: z.literal('CONFIRM'),
        notes: OptionalText,
    }),
    z.object({
        decision: z.literal('REVOKE'),
        /// Recommended for revocations — auditors will ask why.
        notes: OptionalText,
    }),
    z.object({
        decision: z.literal('MODIFY'),
        /// The writers' list, NOT `z.nativeEnum(Role)`: closing the campaign
        /// writes this value to the membership, so a role nothing may write
        /// yet (AI_ADMIN, #3699 deploy 1) is refused here at submission.
        modifiedToRole: z.enum(ASSIGNABLE_TENANT_ROLES),
        /// Only meaningful when the target role uses a TenantCustomRole.
        modifiedToCustomRoleId: z.string().min(1).optional().nullable(),
        notes: OptionalText,
    }),
]);

export type SubmitDecisionInput = z.infer<typeof SubmitDecisionSchema>;

/**
 * Audit Coherence S7 (2026-05-24) — reset a submitted decision back
 * to pending. The reviewer who recorded the wrong verdict can
 * undo + re-record without admin intervention.
 *
 * `reason` is REQUIRED — the audit row carries it as the rationale,
 * SOC 2 auditors will ask why a decision was unwound.
 */
export const RevokeDecisionSchema = z.object({
    reason: z.string().min(3).max(2000),
});

export type RevokeDecisionInput = z.infer<typeof RevokeDecisionSchema>;
