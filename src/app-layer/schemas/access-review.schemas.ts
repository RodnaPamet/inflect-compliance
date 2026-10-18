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
import { ASSIGNABLE_TENANT_ROLES } from '@/lib/roles';
import {
    AGENT_CAMPAIGN_REFUSAL,
    MEMBER_ACCESS_REVIEW_SCOPES,
} from '@/lib/access-review/scope';

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

/**
 * The scope a MEMBER campaign may be created with, and nothing else.
 *
 * This was `z.nativeEnum(AccessReviewScope)`, which admits every value the
 * generated enum carries — so the day AGENT joined the enum, this route would
 * have accepted it without any file naming it, and snapshotted tenant
 * memberships into a campaign labelled AGENT. It already did that for
 * CONNECTED_APP and LEGACY_APP: a member campaign stamped with either is one
 * whose close and detail page read the OTHER decision table, so it could never
 * be closed. Those scopes have their own routes; this one creates member
 * campaigns only, and says which route to use rather than "invalid enum value".
 */
function memberScopeRefusal(input: unknown): string {
    if (input === 'AGENT') {
        return `${AGENT_CAMPAIGN_REFUSAL}: an AGENT campaign is not created through this route, `
            + 'and this release creates none.';
    }
    if (input === 'CONNECTED_APP') {
        return 'SCOPE_HAS_ITS_OWN_ROUTE: a CONNECTED_APP campaign is created at POST /access-reviews/connected.';
    }
    if (input === 'LEGACY_APP') {
        return 'SCOPE_HAS_ITS_OWN_ROUTE: a LEGACY_APP campaign is created from a reconciled legacy snapshot, not here.';
    }
    return `scope must be one of ${MEMBER_ACCESS_REVIEW_SCOPES.join(', ')}.`;
}

export const CreateAccessReviewSchema = z
    .object({
        name: TextField,
        description: OptionalText,
        scope: z
            .enum(MEMBER_ACCESS_REVIEW_SCOPES, { error: (issue) => memberScopeRefusal(issue.input) })
            .default('ALL_USERS'),
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
        /// writes this value to the membership, and a campaign never promotes
        /// anybody to AI_ADMIN (#3699), so it is refused here at submission.
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
