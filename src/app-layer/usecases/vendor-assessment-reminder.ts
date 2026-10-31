/**
 * Epic G-3 — admin-triggered reminder for an in-flight assessment.
 *
 * Issues a FRESH link (owner decision, 2026-10-30, #4650). Only the
 * key's hash is stored, so the original link cannot be reproduced, and a
 * reminder that linked without a key could never open the questionnaire —
 * useless to the vendor who lost the invitation, which is who a reminder is
 * most often for. So it mints a new key, sends it, and stores its hash in
 * place of the old one: the reminder's link works and the original stops.
 * The new link keeps the original expiry; a reminder never extends access.
 *
 * Pushes a fresh outbox row keyed by today's date, so same-day re-clicks
 * collapse via the existing dedupeKey and tomorrow's creates a new row. The
 * hash is rotated ONLY when the email was queued: a collapsed re-click, or a
 * workspace with notifications off, sends nothing, and rotating then would
 * leave the vendor holding only a link that no longer works.
 *
 * Status guard: only SENT or IN_PROGRESS assessments can be reminded. The
 * link must be unexpired and unrevoked — a reminder never revives access an
 * admin withdrew, or extends access that has run out.
 *
 * @module usecases/vendor-assessment-reminder
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { assertCanRunAssessment } from '../policies/vendor.policies';
import { enqueueEmail } from '../notifications/enqueue';
import { mintExternalAccessToken } from './vendor-assessment-send';

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
                revokedAt: true,
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
        if (a.revokedAt) {
            throw badRequest(
                'The link for this assessment was revoked, so a reminder cannot open it.',
            );
        }
        if (!a.vendor || !a.templateVersion) {
            throw badRequest('Assessment is missing vendor or template context.');
        }

        // A fresh key for the reminder's link (see the module header). Its
        // hash replaces the stored one below, and only if the email is queued.
        const { raw: rawToken, hash: tokenHash } = mintExternalAccessToken();
        const responseUrl = buildReminderUrl(a.id, rawToken);

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

        // Same transaction as the outbox row: the email and the key it carries
        // commit together or not at all.
        const linkReissued = result !== null;
        if (linkReissued) {
            await db.vendorAssessment.update({
                where: { id: a.id, tenantId: ctx.tenantId },
                data: { externalAccessTokenHash: tokenHash },
            });
        }

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
                    // The reminder carried a fresh link, and the earlier one stopped working.
                    linkReissued,
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

function buildReminderUrl(assessmentId: string, rawToken: string): string {
    // env.APP_URL is the validated source of truth (src/env.ts).

    const { env } = require('@/env') as { env: { APP_URL?: string } };
    const origin = (env.APP_URL ?? '').replace(/\/$/, '');
    // The same shape as the invitation's link (`vendor-assessment-send.ts`).
    return `${origin}/vendor-assessment/${assessmentId}?t=${rawToken}`;
}
