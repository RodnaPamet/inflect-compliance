/**
 * Enqueue an email into the NotificationOutbox.
 *
 * - Builds email content from templates.
 * - Computes dedupeKey to prevent duplicate sends for the same event.
 * - Uses Prisma's unique constraint to skip silently on duplicates.
 * - Logs with requestId for correlation.
 */

import type { PrismaTx } from '@/lib/db-context';
import type { EmailNotificationType } from '@prisma/client';
import { isNotificationsEnabled } from './settings';
import { logger } from '@/lib/observability/logger';
import { hashForLookup } from '@/lib/security/encryption';
import {
    buildTaskAssignedEmail,
    buildEvidenceExpiringEmail,
    buildPolicyApprovalRequestedEmail,
    buildPolicyDecisionEmail,
    buildVendorAssessmentInvitationEmail,
    buildVendorAssessmentReminderEmail,
    buildVendorAssessmentSubmittedEmail,
    buildVendorAssessmentReviewedEmail,
    buildAccessReviewReminderEmail,
    buildAccessReviewOverdueEscalationEmail,
    buildExceptionExpiringEmail,
    type TaskAssignedPayload,
    type EvidenceExpiringPayload,
    type PolicyApprovalRequestedPayload,
    type PolicyDecisionPayload,
    type VendorAssessmentInvitationPayload,
    type VendorAssessmentReminderPayload,
    type VendorAssessmentSubmittedPayload,
    type VendorAssessmentReviewedPayload,
    type AccessReviewReminderPayload,
    type AccessReviewOverdueEscalationPayload,
    type ExceptionExpiringPayload,
} from './templates';
import {
    buildIdentityLeaverDisabledEmail,
    buildIdentityLeaverUnconfirmedEmail,
    buildIdentityLeaverNeedsActionEmail,
    type IdentityLeaverDisabledPayload,
    type IdentityLeaverUnconfirmedPayload,
    type IdentityLeaverNeedsActionPayload,
} from './leaver-templates';

export interface EnqueueEmailInput {
    tenantId: string;
    type: EmailNotificationType;
    toEmail: string;
    entityId: string;
    payload:
        | TaskAssignedPayload
        | EvidenceExpiringPayload
        | PolicyApprovalRequestedPayload
        | PolicyDecisionPayload
        | VendorAssessmentInvitationPayload
        | VendorAssessmentReminderPayload
        | VendorAssessmentSubmittedPayload
        | VendorAssessmentReviewedPayload
        | AccessReviewReminderPayload
        | AccessReviewOverdueEscalationPayload
        | ExceptionExpiringPayload
        | IdentityLeaverDisabledPayload
        | IdentityLeaverUnconfirmedPayload
        | IdentityLeaverNeedsActionPayload;
    sendAfter?: Date;
    requestId?: string;
}

/**
 * Build a dedupe key for idempotent email sending.
 *
 * Format: `{tenantId}:{type}:{recipientHash}:{entityId}:{YYYY-MM-DD}`
 *
 * ─── WHY THE RECIPIENT IS HASHED (#3577) ───────────────────────────────────
 *
 * This key used to embed the address itself. The row already carries it in
 * `toEmail`, so that was not a new disclosure — it was THE SAME PERSONAL DATA
 * IN A SECOND PLACE, which is what makes a deletion or a DSAR incomplete:
 * anything that redacts, encrypts or drops `toEmail` leaves the address intact
 * in a uniquely-indexed column with no retention rule of its own. The model
 * already has a `toEmailEncrypted` column beside the plaintext, so somebody had
 * judged the address worth protecting; the key was simply not part of that
 * judgement, and it is the copy nobody would think to look for.
 *
 * It surfaced while tracing #3573's 520 undelivered emails: `dedupeKey` was the
 * only column that could say which entity each failed row was about, so reading
 * it was the natural debugging move — and reading it is a disclosure.
 *
 * ─── WHY `hashForLookup` AND NOT A NEW CONSTRUCTION ────────────────────────
 *
 * Because the repository already solved this exact problem. `hashForLookup` is
 * the blind-index primitive behind the `emailHash` columns `auth.ts` and
 * `credentials.ts` use to find a user without storing the address in the clear:
 * HMAC-SHA256 under an HKDF-derived subkey of `DATA_ENCRYPTION_KEY`, with the
 * production-required / dev-fallback handling already in place. Inventing a
 * second keyed hash here would have meant a second key to source, a second
 * rotation story and a second thing to get wrong.
 *
 * KEYED, not a bare digest, and that distinction is the whole value: an
 * unkeyed SHA-256 of a corporate address is reversible by dictionary attack
 * over a known user base, so it would pseudonymise nothing.
 *
 * ─── ONE BEHAVIOUR CHANGE, STATED RATHER THAN HIDDEN ───────────────────────
 *
 * `hashForLookup` lowercases and trims before hashing, so `Alice@acme.com` and
 * `alice@acme.com` now produce the SAME key and the second is deduped away.
 * That is more correct — one mailbox, one notification — but it is a change,
 * and it could have collided on the unique index during the backfill. Measured
 * against production first: 1,085 rows produce 1,085 distinct new keys, 0
 * colliding groups, and 0 addresses differing only by case. So nothing in the
 * existing data is affected.
 */
export function buildDedupeKey(
    tenantId: string,
    type: string,
    email: string,
    entityId: string,
    date: Date = new Date(),
): string {
    const day = date.toISOString().slice(0, 10); // YYYY-MM-DD
    return `${tenantId}:${type}:${hashForLookup(email)}:${entityId}:${day}`;
}

/**
 * Enqueue an email notification into the outbox.
 * Silently skips if dedupeKey already exists (idempotent).
 * Silently skips if tenant notifications are disabled.
 *
 * @returns The created record, or null if duplicate/disabled.
 */
export async function enqueueEmail(
    db: PrismaTx,
    input: EnqueueEmailInput,
): Promise<{ id: string; dedupeKey: string } | null> {
    const { tenantId, type, toEmail, entityId, payload, sendAfter, requestId } = input;

    // Check tenant settings — skip if disabled
    const enabled = await isNotificationsEnabled(db, tenantId);
    if (!enabled) {
        if (requestId) {
            logger.debug('notification skipped — disabled for tenant', { component: 'notifications' });
        }
        return null;
    }

    // Build email content from template
    const { subject, bodyText, bodyHtml } = buildEmailContent(type, payload);

    // Compute dedupe key
    const dedupeKey = buildDedupeKey(tenantId, type, toEmail, entityId);

    try {
        const record = await db.notificationOutbox.create({
            data: {
                tenantId,
                type,
                toEmail,
                subject,
                bodyText,
                bodyHtml,
                dedupeKey,
                ...(sendAfter ? { sendAfter } : {}),
            },
        });

        if (requestId) {
            logger.debug('notification enqueued', { component: 'notifications', type });
        }

        return { id: record.id, dedupeKey };
    } catch (error: unknown) {
        // Prisma P2002 = unique constraint violation → duplicate, skip silently
        if (isPrismaUniqueConstraintError(error)) {
            if (requestId) {
                logger.debug('notification skipped — duplicate', { component: 'notifications', type });
            }
            return null;
        }
        throw error;
    }
}

/**
 * Build email content based on notification type.
 */
function buildEmailContent(
    type: EmailNotificationType,
    payload:
        | TaskAssignedPayload
        | EvidenceExpiringPayload
        | PolicyApprovalRequestedPayload
        | PolicyDecisionPayload
        | VendorAssessmentInvitationPayload
        | VendorAssessmentReminderPayload
        | VendorAssessmentSubmittedPayload
        | VendorAssessmentReviewedPayload
        | AccessReviewReminderPayload
        | AccessReviewOverdueEscalationPayload
        | ExceptionExpiringPayload
        | IdentityLeaverDisabledPayload
        | IdentityLeaverUnconfirmedPayload
        | IdentityLeaverNeedsActionPayload,
): { subject: string; bodyText: string; bodyHtml: string } {
    switch (type) {
        case 'TASK_ASSIGNED':
            return buildTaskAssignedEmail(payload as TaskAssignedPayload);
        case 'EVIDENCE_EXPIRING':
            return buildEvidenceExpiringEmail(payload as EvidenceExpiringPayload);
        case 'POLICY_APPROVAL_REQUESTED':
            return buildPolicyApprovalRequestedEmail(payload as PolicyApprovalRequestedPayload);
        case 'POLICY_APPROVED':
            return buildPolicyDecisionEmail({ ...(payload as PolicyDecisionPayload), decision: 'APPROVED' });
        case 'POLICY_REJECTED':
            return buildPolicyDecisionEmail({ ...(payload as PolicyDecisionPayload), decision: 'REJECTED' });
        case 'VENDOR_ASSESSMENT_INVITATION':
            return buildVendorAssessmentInvitationEmail(
                payload as VendorAssessmentInvitationPayload,
            );
        case 'VENDOR_ASSESSMENT_REMINDER':
            return buildVendorAssessmentReminderEmail(
                payload as VendorAssessmentReminderPayload,
            );
        case 'VENDOR_ASSESSMENT_SUBMITTED':
            return buildVendorAssessmentSubmittedEmail(
                payload as VendorAssessmentSubmittedPayload,
            );
        case 'VENDOR_ASSESSMENT_REVIEWED':
            return buildVendorAssessmentReviewedEmail(
                payload as VendorAssessmentReviewedPayload,
            );
        case 'ACCESS_REVIEW_REMINDER':
            return buildAccessReviewReminderEmail(
                payload as AccessReviewReminderPayload,
            );
        case 'ACCESS_REVIEW_OVERDUE_ESCALATION':
            return buildAccessReviewOverdueEscalationEmail(
                payload as AccessReviewOverdueEscalationPayload,
            );
        case 'EXCEPTION_EXPIRING':
            return buildExceptionExpiringEmail(
                payload as ExceptionExpiringPayload,
            );
        // JML leaver offboarding. Three types rather than one because the
        // outbox dedupe key includes the type, and the "we could not confirm
        // it" mail and the later "we have now confirmed it" mail address the
        // SAME journal row — collapsing them would suppress the resolution,
        // which is the half a human is waiting on.
        case 'IDENTITY_LEAVER_DISABLED':
            return buildIdentityLeaverDisabledEmail(
                payload as IdentityLeaverDisabledPayload,
            );
        case 'IDENTITY_LEAVER_UNCONFIRMED':
            return buildIdentityLeaverUnconfirmedEmail(
                payload as IdentityLeaverUnconfirmedPayload,
            );
        case 'IDENTITY_LEAVER_NEEDS_ACTION':
            return buildIdentityLeaverNeedsActionEmail(
                payload as IdentityLeaverNeedsActionPayload,
            );
        default:
            throw new Error(`Unknown notification type: ${type}`);
    }
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
    const e = error as { code?: unknown; message?: unknown } | null | undefined;
    return e?.code === 'P2002' || (typeof e?.message === 'string' && e.message.includes('Unique constraint'));
}
