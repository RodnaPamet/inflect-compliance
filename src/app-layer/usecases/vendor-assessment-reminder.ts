/**
 * Epic G-3 — admin-triggered reminder for an in-flight assessment.
 *
 * Reuses the existing token (no new mint), pushes a fresh outbox
 * row keyed by today's date so same-day re-clicks collapse via the
 * existing dedupeKey but tomorrow's resend creates a new row.
 *
 * Status guard: only SENT or IN_PROGRESS assessments can be
 * reminded. Token must still be unexpired — if the original
 * link has expired, the admin must send a new assessment instead.
 *
 * @module usecases/vendor-assessment-reminder
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { assertCanRunAssessment } from '../policies/vendor.policies';
import { enqueueEmail } from '../notifications/enqueue';

export interface SendReminderResult {
    notificationQueued: boolean;
    expiresAt: Date;
}

export async function sendAssessmentReminder(
    ctx: RequestContext,
    assessmentId: string,
): Promise<SendReminderResult> {
    assertCanRunAssessment(ctx);

    return runInTenantContext(ctx, async (db) => {
        const a = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                tenantId: true,
                status: true,
                respondentEmail: true,
                externalAccessTokenExpiresAt: true,
                vendor: { select: { name: true } },
                templateVersion: { select: { name: true } },
                requestedBy: { select: { name: true } },
            },
        });
        if (!a) throw notFound('Assessment not found');
        if (a.status !== 'SENT' && a.status !== 'IN_PROGRESS') {
            throw badRequest(
                `Cannot send a reminder for an assessment in status ${a.status}.`,
            );
        }
        if (!a.respondentEmail) {
            throw badRequest('Assessment has no respondent email on file.');
        }
        if (
            !a.externalAccessTokenExpiresAt ||
            a.externalAccessTokenExpiresAt.getTime() < Date.now()
        ) {
            throw badRequest(
                'External access token has expired. Send a new assessment instead.',
            );
        }
        if (!a.vendor || !a.templateVersion) {
            throw badRequest('Assessment is missing vendor or template context.');
        }

        // The raw token cannot be recovered server-side — only its hash is
        // stored, which is the point — so the reminder cannot reproduce the
        // original URL. It links to /vendor-assessment/{id} without a token.
        //
        // That page used to title a tokenless visit "This link is no longer
        // active", which is false and alarming for someone whose invitation
        // is perfectly valid: the reminder simply cannot carry the token. It
        // now has a distinct missing_token state telling the respondent to
        // open their original invitation, or ask for a new one.
        const responseUrl = buildReminderUrl(a.id);

        const result = await enqueueEmail(db, {
            tenantId: a.tenantId,
            type: 'VENDOR_ASSESSMENT_REMINDER',
            toEmail: a.respondentEmail,
            entityId: a.id,
            payload: {
                recipientName: 'there',
                vendorName: a.vendor.name,
                templateName: a.templateVersion.name,
                responseUrl,
                expiresAtIso: a.externalAccessTokenExpiresAt.toISOString(),
                inviterName: a.requestedBy?.name ?? undefined,
            },
            requestId: ctx.requestId,
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_REMINDER_SENT',
            entityType: 'VendorAssessment',
            entityId: a.id,
            details: `Sent reminder for assessment ${a.id}`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessment',
                operation: 'reminded',
                after: {
                    notificationQueued: result !== null,
                    expiresAt: a.externalAccessTokenExpiresAt.toISOString(),
                },
                summary: `Vendor assessment reminder sent`,
            },
        });

        return {
            notificationQueued: result !== null,
            expiresAt: a.externalAccessTokenExpiresAt,
        };
    });
}

function buildReminderUrl(assessmentId: string): string {
    // env.APP_URL is the validated source of truth (src/env.ts).

    const { env } = require('@/env') as { env: { APP_URL?: string } };
    const origin = (env.APP_URL ?? '').replace(/\/$/, '');
    return `${origin}/vendor-assessment/${assessmentId}`;
}
