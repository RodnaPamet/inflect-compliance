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
import { readWorkspaceLocale, workspaceTranslator, type WorkspaceTranslator } from '@/lib/i18n/workspace-text';
import {
    buildTaskAssignedEmail,
    buildTaskAssignedDigestEmail,
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
    TASK_ASSIGNED_EMAIL_NAMESPACE,
    type TaskAssignedPayload,
    type TaskAssignedDigestPayload,
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
        | TaskAssignedDigestPayload
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

    // Build email content from template. The single-task TASK_ASSIGNED email
    // is written in the workspace's default language (owner decision
    // 2026-11-25), read here once per email: the row is sent as rendered, so
    // this is the one place the language can be chosen. Every other email,
    // the bulk digest included, is still English.
    const t = isSingleTaskAssigned(type, payload)
        ? await workspaceTranslator(await readWorkspaceLocale(db, tenantId), TASK_ASSIGNED_EMAIL_NAMESPACE)
        : null;
    const { subject, bodyText, bodyHtml } = buildEmailContent(type, payload, t);

    // Compute dedupe key
    const dedupeKey = buildDedupeKey(tenantId, type, toEmail, entityId);

    // ON CONFLICT DO NOTHING, never a caught P2002 (#5061). Callers pass
    // their interactive transaction, and a statement that fails inside one
    // aborts it in Postgres: the duplicate was swallowed here, then the
    // caller's next statement, or its commit, failed with 25P02 and rolled
    // back the assignment or approval request the email was about.
    const { count } = await db.notificationOutbox.createMany({
        data: [
            {
                tenantId,
                type,
                toEmail,
                subject,
                bodyText,
                bodyHtml,
                dedupeKey,
                ...(sendAfter ? { sendAfter } : {}),
            },
        ],
        skipDuplicates: true,
    });
    if (count === 0) {
        if (requestId) {
            logger.debug('notification skipped — duplicate', { component: 'notifications', type });
        }
        return null;
    }
    const record = await db.notificationOutbox.findUnique({
        where: { dedupeKey },
        select: { id: true },
    });
    if (requestId) {
        logger.debug('notification enqueued', { component: 'notifications', type });
    }
    return record ? { id: record.id, dedupeKey } : null;
}

type EmailPayload = EnqueueEmailInput['payload'];

/**
 * A bulk Assign's digest rides the TASK_ASSIGNED type (#4278): adding an
 * `EmailNotificationType` value is a migration, and a container whose Prisma
 * client predates the value fails reading the row. The payload's shape says
 * which body to build.
 */
function isSingleTaskAssigned(type: EmailNotificationType, payload: EmailPayload): payload is TaskAssignedPayload {
    return type === 'TASK_ASSIGNED' && !('tasks' in payload);
}

/**
 * Build email content based on notification type. `t` is the workspace-language
 * translator for the single-task TASK_ASSIGNED email, and `null` for every
 * other email.
 */
function buildEmailContent(
    type: EmailNotificationType,
    payload: EmailPayload,
    t: WorkspaceTranslator | null,
): { subject: string; bodyText: string; bodyHtml: string } {
    switch (type) {
        case 'TASK_ASSIGNED':
            if (isSingleTaskAssigned(type, payload)) {
                if (!t) throw new Error('TASK_ASSIGNED email built without its workspace translator');
                return buildTaskAssignedEmail(payload, t);
            }
            return buildTaskAssignedDigestEmail(payload as TaskAssignedDigestPayload);
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
