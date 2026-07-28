/**
 * Epic G-3 — Vendor Assessment outbound send.
 *
 * Turns a published `VendorAssessmentTemplate` into a concrete
 * `VendorAssessment` instance for a specific vendor and queues the
 * external respondent's invitation email through the canonical
 * notification outbox.
 *
 * ═══════════════════════════════════════════════════════════════════
 * INVARIANTS
 * ═══════════════════════════════════════════════════════════════════
 *
 *   • Source template stays canonical. The instance pins to a
 *     specific template version via `templateVersionId`; it does
 *     not copy questions into a "live response document". Section
 *     and question structure is read through the template→sections
 *     →questions relation graph at render time. Subsequent template
 *     edits must clone (Epic G-3 prompt 2's edit-safety guard) so
 *     they cannot mutate the in-flight version.
 *
 *   • Token generation uses a 32-byte cryptographically random
 *     value. The raw token is returned to the caller ONCE (and
 *     embedded in the email URL); only its SHA-256 hash is stored.
 *     A leaked database snapshot cannot reveal the raw token.
 *
 *   • Idempotency. The outbox table's `dedupeKey` unique constraint
 *     ensures repeated sends within the same calendar day for the
 *     same (assessment, recipient) pair silently no-op. The
 *     usecase additionally refuses to mint a fresh assessment when
 *     a SENT/IN_PROGRESS one already exists for the same vendor +
 *     templateVersion + recipientEmail unless `force=true`.
 *
 *   • Lifecycle. The new assessment is created directly in `SENT`
 *     state (skipping the DRAFT bookkeeping that exists for the
 *     legacy approval flow). `sentAt` and `sentByUserId` stamp the
 *     trigger.
 *
 * @module usecases/vendor-assessment-send
 */
import { createHash, randomBytes } from 'crypto';
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { assertCanRunAssessment } from '../policies/vendor.policies';
import { enqueueEmail } from '../notifications/enqueue';

// ─── Types ─────────────────────────────────────────────────────────

export interface SendAssessmentInput {
    /// Email of the external respondent. The invitation is delivered
    /// here. The address is also stamped on the new assessment row
    /// for traceability.
    respondentEmail: string;
    /// Optional human name for the email greeting.
    respondentName?: string;
    /// Days until the external link expires. Default 14, max 90.
    expiresInDays?: number;
    /// Override the default origin for the response URL. Useful in
    /// dev / test where APP_URL may not be set. The token is
    /// appended as `?t=<raw>`.
    appOriginOverride?: string;
    /// Skip the in-flight-assessment idempotency check. The outbox
    /// dedupeKey still prevents same-day double-send.
    force?: boolean;
}

export interface SendAssessmentResult {
    assessmentId: string;
    /// The raw access token. Returned ONCE — the caller is
    /// responsible for ensuring it's only persisted in the email
    /// body (which the usecase does for them via enqueueEmail).
    externalAccessToken: string;
    expiresAt: Date;
    /// True when the outbox row was created. False when the canonical
    /// outbox dedupe collapsed the send (notifications disabled OR
    /// same-day duplicate).
    notificationQueued: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Generate a 32-byte cryptographically random token, returned as a
 * URL-safe base64 string. SHA-256 hash is what gets stored.
 */
function mintExternalAccessToken(): { raw: string; hash: string } {
    const raw = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(raw).digest('hex');
    return { raw, hash };
}

function clamp(n: number, min: number, max: number): number {
    if (Number.isNaN(n)) return min;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function resolveAppOrigin(override?: string): string {
    if (override) return override.replace(/\/$/, '');
    // env.APP_URL is the validated source of truth (src/env.ts).
    // Last-resort default keeps dev/test happy when APP_URL is unset.

    const { env } = require('@/env') as { env: { APP_URL?: string } };
    if (env.APP_URL && env.APP_URL.length > 0) {
        return env.APP_URL.replace(/\/$/, '');
    }
    return 'http://localhost:3000';
}

// ─── Entry point ───────────────────────────────────────────────────

/**
 * Create a vendor assessment instance from a published template
 * and queue the invitation email.
 *
 * Returns the assessment id, the RAW access token (for surface
 * UIs that need to reveal the link), the expiry, and whether the
 * outbox row was actually queued.
 */
export async function sendAssessment(
    ctx: RequestContext,
    vendorId: string,
    templateVersionId: string,
    input: SendAssessmentInput,
): Promise<SendAssessmentResult> {
    assertCanRunAssessment(ctx);
    if (!input.respondentEmail || !input.respondentEmail.includes('@')) {
        throw badRequest('A valid respondent email is required.');
    }

    const expiresInDays = clamp(input.expiresInDays ?? 14, 1, 90);
    const expiresAt = new Date(
        Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
    );
    const respondentEmail = input.respondentEmail.trim().toLowerCase();
    const respondentName = input.respondentName
        ? sanitizePlainText(input.respondentName)
        : 'Vendor team';

    return runInTenantContext(ctx, async (db) => {
        // ── Load + validate vendor ──
        const vendor = await db.vendor.findFirst({
            where: { id: vendorId, tenantId: ctx.tenantId },
            select: { id: true, name: true },
        });
        if (!vendor) throw notFound('Vendor not found');

        // ── Load + validate template ──
        const template = await db.vendorAssessmentTemplate.findFirst({
            where: { id: templateVersionId, tenantId: ctx.tenantId },
            select: {
                id: true,
                name: true,
                isPublished: true,
            },
        });
        if (!template) throw notFound('Template not found');
        if (!template.isPublished) {
            throw badRequest(
                `Template "${template.name}" is in draft. Publish it before sending.`,
            );
        }

        // ── Idempotency: refuse fresh send when one is already in flight ──
        if (!input.force) {
            const inFlight = await db.vendorAssessment.findFirst({
                where: {
                    tenantId: ctx.tenantId,
                    vendorId: vendor.id,
                    templateVersionId: template.id,
                    respondentEmail,
                    status: { in: ['SENT', 'IN_PROGRESS'] },
                },
                select: { id: true },
            });
            if (inFlight) {
                throw badRequest(
                    `An assessment is already in flight for this vendor + template + recipient. ` +
                        `Pass force=true to send a parallel one.`,
                );
            }
        }

        // ── Mint token + create assessment ──
        const { raw: rawToken, hash: tokenHash } = mintExternalAccessToken();

        const assessment = await db.vendorAssessment.create({
            data: {
                tenantId: ctx.tenantId,
                vendorId: vendor.id,
                // Legacy templateId left null — G-3 sends only carry
                // templateVersionId. The schema follow-up (prompt 3
                // migration) made templateId nullable.
                templateId: null,
                templateVersionId: template.id,
                requestedByUserId: ctx.userId,
                status: 'SENT',
                startedAt: new Date(),
                sentAt: new Date(),
                sentByUserId: ctx.userId,
                respondentEmail,
                externalAccessTokenHash: tokenHash,
                externalAccessTokenExpiresAt: expiresAt,
            },
            select: { id: true },
        });

        // ── Build response URL with raw token ──
        // The raw token only ever appears here (in the email body).
        // The DB stores only the SHA-256 hash.
        const origin = resolveAppOrigin(input.appOriginOverride);
        const responseUrl = `${origin}/vendor-assessment/${assessment.id}?t=${rawToken}`;

        // ── Queue the invitation email through the canonical outbox ──
        // enqueueEmail honours TenantNotificationSettings.enabled and
        // returns null when the same-day dedupeKey already exists.
        const outboxResult = await enqueueEmail(db, {
            tenantId: ctx.tenantId,
            type: 'VENDOR_ASSESSMENT_INVITATION',
            toEmail: respondentEmail,
            entityId: assessment.id,
            payload: {
                recipientName: respondentName,
                vendorName: vendor.name,
                templateName: template.name,
                responseUrl,
                expiresAtIso: expiresAt.toISOString(),
                inviterName: ctx.userId, // best-effort — replaced by name lookup later
            },
            requestId: ctx.requestId,
        });

        // ── Audit ──
        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_SENT',
            entityType: 'VendorAssessment',
            entityId: assessment.id,
            details:
                `Sent assessment "${template.name}" to ${respondentEmail} ` +
                `(vendor=${vendor.name}, expires=${expiresAt.toISOString()})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessment',
                operation: 'sent',
                after: {
                    vendorId: vendor.id,
                    templateVersionId: template.id,
                    respondentEmail,
                    expiresAt: expiresAt.toISOString(),
                    notificationQueued: outboxResult !== null,
                },
                summary: `Vendor assessment invitation sent`,
            },
        });

        return {
            assessmentId: assessment.id,
            externalAccessToken: rawToken,
            expiresAt,
            notificationQueued: outboxResult !== null,
        };
    });
}

/**
 * PR-S — resend the invite for an in-flight (SENT / IN_PROGRESS) assessment.
 *
 * The original share link is unrecoverable — only its SHA-256 hash is stored —
 * so a true "resend" MINTS A FRESH token (invalidating the old one), re-stamps
 * the expiry + sentAt, and re-queues the invitation email with a working link.
 * Returns the new raw link so the admin surface can reveal it (the one-time
 * link shown at send is no longer the only artifact). canRunAssessment gate.
 */
export async function resendAssessmentInvite(
    ctx: RequestContext,
    assessmentId: string,
    input: { expiresInDays?: number; appOriginOverride?: string } = {},
): Promise<SendAssessmentResult> {
    assertCanRunAssessment(ctx);

    const expiresInDays = clamp(input.expiresInDays ?? 14, 1, 90);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    return runInTenantContext(ctx, async (db) => {
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                status: true,
                respondentEmail: true,
                vendor: { select: { id: true, name: true } },
                templateVersion: { select: { name: true } },
            },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (assessment.status !== 'SENT' && assessment.status !== 'IN_PROGRESS') {
            throw badRequest(
                `Cannot resend an assessment in status ${assessment.status}. ` +
                    `Only SENT or IN_PROGRESS assessments can be resent.`,
            );
        }
        if (!assessment.respondentEmail) {
            throw badRequest('This assessment has no respondent email to resend to.');
        }

        // Mint a FRESH token — the old link is invalidated.
        const { raw: rawToken, hash: tokenHash } = mintExternalAccessToken();
        await db.vendorAssessment.update({
            where: { id: assessment.id },
            data: {
                externalAccessTokenHash: tokenHash,
                externalAccessTokenExpiresAt: expiresAt,
                sentAt: new Date(),
                sentByUserId: ctx.userId,
            },
        });

        const origin = resolveAppOrigin(input.appOriginOverride);
        const responseUrl = `${origin}/vendor-assessment/${assessment.id}?t=${rawToken}`;

        const outboxResult = await enqueueEmail(db, {
            tenantId: ctx.tenantId,
            type: 'VENDOR_ASSESSMENT_INVITATION',
            toEmail: assessment.respondentEmail,
            entityId: assessment.id,
            payload: {
                recipientName: 'Vendor team',
                vendorName: assessment.vendor?.name ?? '',
                templateName: assessment.templateVersion?.name ?? '',
                responseUrl,
                expiresAtIso: expiresAt.toISOString(),
                inviterName: ctx.userId,
            },
            requestId: ctx.requestId,
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_RESENT',
            entityType: 'VendorAssessment',
            entityId: assessment.id,
            details: `Resent assessment invite to ${assessment.respondentEmail} (fresh link, expires ${expiresAt.toISOString()})`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessment',
                operation: 'sent',
                after: { respondentEmail: assessment.respondentEmail, expiresAt: expiresAt.toISOString(), notificationQueued: outboxResult !== null },
                summary: 'Vendor assessment invitation resent',
            },
        });

        return {
            assessmentId: assessment.id,
            externalAccessToken: rawToken,
            expiresAt,
            notificationQueued: outboxResult !== null,
        };
    });
}

/**
 * Revoke the external respondent link without rotating the token.
 *
 * Before this existed, a leaked or mis-sent invite had no kill switch. The
 * only recourses were waiting for the expiry, a resend (which MINTS a fresh
 * token and therefore invalidates any link already circulating — useless
 * when the goal is simply to stop the leaked one), or dragging the
 * assessment status out of SENT / IN_PROGRESS, which corrupts the lifecycle
 * to achieve a security outcome.
 *
 * `verifyAccessToken` denies on `revokedAt`, so the effect is immediate and
 * does not depend on the assessment's status. Idempotent: revoking an
 * already-revoked link is a no-op rather than an error, because the
 * operator's intent (this link must not work) is already satisfied.
 *
 * Mirrors `revokeShare` in audit-readiness/sharing.ts. canRunAssessment
 * gate — the same tier that can send the link can kill it.
 */
export async function revokeAssessmentLink(
    ctx: RequestContext,
    assessmentId: string,
): Promise<{ assessmentId: string; revokedAt: Date }> {
    assertCanRunAssessment(ctx);

    return runInTenantContext(ctx, async (db) => {
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                status: true,
                revokedAt: true,
                externalAccessTokenHash: true,
                vendor: { select: { name: true } },
            },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (!assessment.externalAccessTokenHash) {
            throw badRequest('This assessment has no external link to revoke.');
        }
        if (assessment.revokedAt) {
            return {
                assessmentId: assessment.id,
                revokedAt: assessment.revokedAt,
            };
        }

        const revokedAt = new Date();
        await db.vendorAssessment.update({
            where: { id: assessment.id, tenantId: ctx.tenantId },
            data: { revokedAt },
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_LINK_REVOKED',
            entityType: 'VendorAssessment',
            entityId: assessment.id,
            details:
                `Revoked the external response link for assessment ` +
                `(vendor=${assessment.vendor?.name ?? 'unknown'})`,
            detailsJson: {
                category: 'status_change',
                entityName: 'VendorAssessment',
                operation: 'link_revoked',
                after: { revokedAt: revokedAt.toISOString() },
            },
        });

        return { assessmentId: assessment.id, revokedAt };
    });
}
