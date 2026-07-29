/**
 * Epic G-3 — Vendor Assessment review + close usecases.
 *
 *   • reviewAssessment   — run the scoring engine, apply per-answer
 *                          overrides, set the final rating, transition
 *                          SUBMITTED → REVIEWED.
 *   • closeAssessment    — terminal lifecycle flip REVIEWED → CLOSED.
 *
 * Traceability invariants:
 *
 *   computedPoints (from submit)   — never overwritten
 *   reviewerOverridePoints         — set/cleared by review
 *   reviewerNotes (per-answer)     — set/cleared by review
 *   assessment.score               — final post-override score
 *   assessment.riskRating          — reviewer override OR engine
 *                                    suggestion (manual wins)
 *   assessment.reviewerNotes       — assessment-level commentary
 *
 * The engine runs entirely on the post-override view of answers, so the
 * recomputation is deterministic: the same overrides always yield the same
 * total, regardless of how many times review runs.
 *
 * NOTE — review is single-shot, not an editing loop. `reviewAssessment`
 * rejects anything whose status is not SUBMITTED, so a reviewer canNOT return
 * to a REVIEWED assessment to tweak an override; the recompute-on-re-review
 * behaviour this doc once described was never reachable. Correcting a
 * completed review currently requires a new assessment cycle. If in-place
 * amendment is wanted, it needs an explicit REVIEWED → SUBMITTED reopen verb
 * with its own authz check and audit action — not a relaxation of this guard,
 * which is also what keeps the risk writeback from firing twice.
 *
 * @module usecases/vendor-assessment-review
 */
import type { RequestContext } from '../types';
import type { VendorCriticality } from '@prisma/client';
import { runInTenantContext } from '@/lib/db-context';
import { notFound, badRequest, forbidden } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { assertCanApproveAssessment } from '../policies/vendor.policies';
import {
    scoreAssessment,
    parseScoringConfig,
    type ScoringResult,
} from '../services/vendor-assessment-scoring-engine';
import { enqueueEmail } from '../notifications/enqueue';
import { createRisk } from '@/app-layer/usecases/risk';
import { addVendorLink, listVendorLinks } from '@/app-layer/usecases/vendor';
import { logger } from '@/lib/observability/logger';
// Audit S6 (2026-05-22) — `notifyAssessmentReviewed` runs
// post-commit, after `runInTenantContext` has returned, so it needs
// a non-tenant-bound prisma client to look up the recipient's email
// and tenant slug. Pre-this-PR the file used a dynamic require()
// inline; that bypassed the `no-direct-prisma`
// structural ratchet but also undermined it (operators reading the
// file couldn't tell whether the global prisma was intentional or
// drift). The static import is paired with an allowlist entry in
// `tests/unit/no-direct-prisma.test.ts`.
import { prisma } from '@/lib/prisma';
import { env } from '@/env';

// ─── Types ─────────────────────────────────────────────────────────

export interface ReviewOverrideInput {
    questionId: string;
    /** undefined = leave untouched; null = clear; number = set. */
    overridePoints?: number | null;
    /** undefined = leave untouched; null = clear; string = set. */
    reviewerNotes?: string | null;
}

export interface ReviewAssessmentInput {
    overrides?: ReviewOverrideInput[];
    /** Manual rating override. undefined = use engine suggestion. */
    finalRiskRating?: VendorCriticality | null;
    /** Assessment-level reviewer commentary. */
    reviewerNotes?: string | null;
}

export interface ReviewAssessmentResult {
    status: 'REVIEWED';
    score: number;
    riskRating: VendorCriticality | null;
    /** True when finalRiskRating came from the input (manual override),
     *  false when it was derived from the engine's suggestion. */
    ratingOverridden: boolean;
    /** Full scoring breakdown — drives the review-detail UI. */
    scoring: ScoringResult;
    reviewedAt: Date;
    /** PR-S — id of the register Risk this review auto-created (HIGH/CRITICAL),
     *  so the review UI can toast a link to it. null when none was created. */
    autoCreatedRiskId: string | null;
}

export interface CloseAssessmentResult {
    status: 'CLOSED';
    closedAt: Date;
}

// ─── 1. reviewAssessment ───────────────────────────────────────────

export async function reviewAssessment(
    ctx: RequestContext,
    assessmentId: string,
    input: ReviewAssessmentInput,
): Promise<ReviewAssessmentResult> {
    assertCanApproveAssessment(ctx);

    const outcome = await runInTenantContext(ctx, async (db) => {
        // ── Load assessment + status guard ──
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                tenantId: true,
                status: true,
                templateVersionId: true,
                templateId: true,
                vendorId: true,
                vendor: { select: { name: true } },
            },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (assessment.status !== 'SUBMITTED') {
            throw badRequest(
                `Cannot review an assessment in status ${assessment.status}. ` +
                    `Only SUBMITTED assessments can be reviewed.`,
            );
        }
        if (!assessment.templateVersionId) {
            // The G-3 review path requires the new normalized
            // template; legacy approval-flow assessments use the
            // existing decideAssessment usecase.
            throw badRequest(
                'This assessment was created via the legacy approval flow. ' +
                    'Use decideAssessment instead.',
            );
        }

        // ── Apply per-answer overrides ──
        const overrides = input.overrides ?? [];
        for (const o of overrides) {
            const data: Record<string, unknown> = {};
            if (o.overridePoints !== undefined) {
                data.reviewerOverridePoints = o.overridePoints;
            }
            if (o.reviewerNotes !== undefined) {
                data.reviewerNotes = o.reviewerNotes
                    ? sanitizePlainText(o.reviewerNotes)
                    : null;
            }
            if (Object.keys(data).length === 0) continue;
            // Use updateMany so a non-existent answer (override on a
            // never-answered question) is a no-op rather than a
            // throw — the reviewer might be ahead of the response.
            await db.vendorAssessmentAnswer.updateMany({
                where: {
                    assessmentId: assessment.id,
                    tenantId: ctx.tenantId,
                    questionId: o.questionId,
                },
                data,
            });
        }

        // ── Reload questions + (post-override) answers for engine ──
        const questions = await db.vendorAssessmentTemplateQuestion.findMany({
            where: {
                templateId: assessment.templateVersionId,
                tenantId: ctx.tenantId,
            },
            select: { id: true, weight: true, required: true },
        });
        const answers = await db.vendorAssessmentAnswer.findMany({
            where: {
                assessmentId: assessment.id,
                tenantId: ctx.tenantId,
            },
            select: {
                questionId: true,
                computedPoints: true,
                reviewerOverridePoints: true,
            },
        });

        const template = await db.vendorAssessmentTemplate.findUnique({
            where: { id: assessment.templateVersionId },
            select: { scoringConfigJson: true },
        });
        const config = parseScoringConfig(template?.scoringConfigJson ?? null);

        // ── Score ──
        const scoring = scoreAssessment({
            questions: questions.map((q) => ({
                id: q.id,
                weight: q.weight,
                required: q.required,
            })),
            answers,
            config,
        });

        // ── Resolve final rating ──
        const ratingOverridden = input.finalRiskRating !== undefined;
        const riskRating: VendorCriticality | null = ratingOverridden
            ? (input.finalRiskRating ?? null)
            : (scoring.suggestedRating ?? null);

        // ── Persist + transition ──
        const reviewedAt = new Date();
        await db.vendorAssessment.update({
            where: { id: assessment.id },
            data: {
                status: 'REVIEWED',
                reviewedAt,
                reviewedByUserId: ctx.userId,
                reviewerNotes: input.reviewerNotes
                    ? sanitizePlainText(input.reviewerNotes)
                    : input.reviewerNotes === null
                        ? null
                        : undefined,
                score: scoring.score,
                riskRating,
                decidedAt: reviewedAt,
                decidedByUserId: ctx.userId,
            },
        });

        // ── Audit ──
        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_REVIEWED',
            entityType: 'VendorAssessment',
            entityId: assessment.id,
            details:
                `Reviewed assessment with ${scoring.mode}: ` +
                `score=${formatScore(scoring.score)}, rating=${riskRating ?? 'none'}, ` +
                `overrides=${overrides.length}` +
                (scoring.verdict ? `, verdict=${scoring.verdict}` : ''),
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessment',
                operation: 'reviewed',
                after: {
                    status: 'REVIEWED',
                    mode: scoring.mode,
                    autoSum: scoring.autoSum,
                    effectiveSum: scoring.effectiveSum,
                    score: scoring.score,
                    riskRating,
                    ratingOverridden,
                    overrideCount: overrides.length,
                    answeredCount: scoring.breakdown.length,
                    verdict: scoring.verdict ?? null,
                    reviewedAt: reviewedAt.toISOString(),
                },
                summary: `Vendor assessment reviewed`,
            },
        });

        // ── Evidence attachment + REVIEWED notification (post-commit) ──
        await attachReviewedAssessmentEvidence(
            ctx,
            db,
            assessment.id,
            scoring.score,
            riskRating,
        );
        await notifyAssessmentReviewed(
            assessment.id,
            scoring.score,
            riskRating,
        );

        const result: ReviewAssessmentResult = {
            status: 'REVIEWED' as const,
            score: scoring.score,
            riskRating,
            ratingOverridden,
            scoring,
            reviewedAt,
            autoCreatedRiskId: null, // filled in post-commit from the writeback
        };
        return {
            result,
            vendorId: assessment.vendorId,
            vendorName: assessment.vendor?.name ?? '',
            riskRating,
        };
    });

    // ── Vendor-risk writeback + auto-create register Risk (post-commit) ──
    // Runs AFTER the review transaction commits: it calls the risk /
    // vendor usecases, each of which opens its own tenant context, so it
    // must sit outside `runInTenantContext`. Best-effort — never fails
    // the review (mirrors `notifyAssessmentReviewed`).
    const writeback = await applyAssessmentRiskWriteback(
        ctx,
        outcome.vendorId,
        outcome.vendorName,
        outcome.riskRating,
    );

    // Surface the auto-created risk to the reviewer (best-effort — the writeback
    // is post-commit, so the review already succeeded regardless).
    return { ...outcome.result, autoCreatedRiskId: writeback.createdRiskId };
}

/**
 * Post-commit vendor-risk writeback (P2.3). Two best-effort effects,
 * each wrapped so a failure is logged but never rolls back the review:
 *
 *   1. Writeback the assessment-derived tier onto the vendor row —
 *      `inherentRisk` + `lastAssessmentReviewedAt`, and (PR-S) roll
 *      `nextReviewAt` forward by the reassessment cadence UNLESS a review
 *      is already scheduled in the future (respects a manually-set date).
 *      `residualRisk` (manually-owned) and `criticality` are NOT touched.
 *   2. On a HIGH/CRITICAL rating, auto-create a register Risk and link
 *      it to the vendor. Idempotent on an ASSESSMENT_SOURCED marker link
 *      (PR-S) — NOT "any RISK link", so an unrelated manual risk link no
 *      longer suppresses materialization forever.
 *
 * Returns the id of the risk it auto-created (or null), so the caller can
 * surface it to the reviewer. Both effects call usecases that open their own
 * tenant context, so this MUST run outside the review transaction.
 *
 * Creation and linking are deliberately SEPARATE failure domains. `createRisk`
 * and `addVendorLink` are distinct usecases, each opening its own transaction,
 * so they cannot be made atomic without reaching past the usecase layer into
 * the repositories — which would invert the layering this codebase enforces.
 * Instead: if the link fails, the committed Risk id is STILL returned (with
 * `linkFailed: true`) and the failure is logged at `error`. The alternative —
 * reporting null because the second step failed — would leave a real Risk in
 * the register that nobody was told about.
 */
// PR-S — matches vendor-reassessment-reminder's DEFAULT_CADENCE_DAYS (annual
// review cycle; ISO 27001). Duplicated as a small well-known constant to avoid
// coupling the review path to the reminder-job module.
const REASSESSMENT_CADENCE_DAYS = 365;

async function applyAssessmentRiskWriteback(
    ctx: RequestContext,
    vendorId: string,
    vendorName: string,
    riskRating: VendorCriticality | null,
): Promise<{ createdRiskId: string | null; linkFailed?: boolean }> {
    if (!riskRating) return { createdRiskId: null };

    // 1. Writeback inherent tier + review timestamp + next-review roll.
    try {
        const now = new Date();
        // PR-S — only roll nextReviewAt when nothing is already scheduled in the
        // future, so a deliberately-set manual review date is preserved.
        const existing = await prisma.vendor.findFirst({
            where: { id: vendorId, tenantId: ctx.tenantId },
            select: { nextReviewAt: true },
        });
        const rollNextReview = !existing?.nextReviewAt || existing.nextReviewAt <= now;
        await prisma.vendor.updateMany({
            where: { id: vendorId, tenantId: ctx.tenantId },
            data: {
                inherentRisk: riskRating,
                lastAssessmentReviewedAt: now,
                ...(rollNextReview
                    ? { nextReviewAt: new Date(now.getTime() + REASSESSMENT_CADENCE_DAYS * 86_400_000) }
                    : {}),
            },
        });
    } catch (err) {
        logger.warn(
            'vendor-assessment-review: inherent-risk writeback failed',
            {
                component: 'vendor-assessment-review',
                vendorId,
                err: err instanceof Error ? err : new Error(String(err)),
            },
        );
    }

    // 2. Auto-create a register Risk on high-risk ratings (idempotent).
    if (riskRating !== 'HIGH' && riskRating !== 'CRITICAL') return { createdRiskId: null };
    // Declared outside the try so the link step below — a SEPARATE failure
    // domain — can still report the id of an already-committed Risk.
    let risk: { id: string };
    try {
        const links = await listVendorLinks(ctx, vendorId);
        // PR-S — idempotency keys on the ASSESSMENT_SOURCED marker this writeback
        // sets, NOT "any RISK link". A manual link to some unrelated risk no
        // longer silently suppresses assessment-sourced materialization.
        if (links.some((l) => l.entityType === 'RISK' && l.relation === 'ASSESSMENT_SOURCED')) {
            logger.info(
                'vendor-assessment-review: assessment-sourced RISK link already exists — skipping auto-risk',
                {
                    component: 'vendor-assessment-review',
                    vendorId,
                    riskRating,
                },
            );
            return { createdRiskId: null };
        }

        risk = await createRisk(ctx, {
            title: `Vendor risk: ${vendorName} (${riskRating}) — from assessment`,
            description: `Auto-created from vendor assessment review. Rating: ${riskRating}.`,
            category: 'Third-party',
        });
    } catch (err) {
        // Creation itself failed — nothing was persisted, so reporting null is
        // accurate and there is nothing to reconcile.
        logger.warn(
            'vendor-assessment-review: auto-risk creation failed',
            {
                component: 'vendor-assessment-review',
                vendorId,
                riskRating,
                err: err instanceof Error ? err : new Error(String(err)),
            },
        );
        return { createdRiskId: null };
    }

    // The Risk row is now COMMITTED. Linking is a separate failure domain: it
    // runs in its own tenant context/transaction, so it can fail independently.
    // Folding it back into the creation try/catch (as this once did) meant a
    // failed link reported `createdRiskId: null` while the Risk sat in the
    // register — orphaned, unlinked, and invisible to the reviewer who would
    // then have no idea it existed. A created Risk must never be silently
    // unlinked AND unreported: we always return the id, and escalate the link
    // failure to `error` because it leaves the register needing manual
    // reconciliation (and the ASSESSMENT_SOURCED idempotency marker missing,
    // so a subsequent review would materialise a DUPLICATE risk).
    try {
        await addVendorLink(ctx, vendorId, {
            entityType: 'RISK',
            entityId: risk.id,
            relation: 'ASSESSMENT_SOURCED',
        });
    } catch (err) {
        logger.error(
            'vendor-assessment-review: auto-risk created but vendor link FAILED — risk is orphaned and the ASSESSMENT_SOURCED marker is missing; a later review may create a duplicate',
            {
                component: 'vendor-assessment-review',
                vendorId,
                riskId: risk.id,
                riskRating,
                err: err instanceof Error ? err : new Error(String(err)),
            },
        );
        return { createdRiskId: risk.id, linkFailed: true };
    }

    logger.info(
        'vendor-assessment-review: auto-created register risk from high-risk assessment',
        {
            component: 'vendor-assessment-review',
            vendorId,
            riskId: risk.id,
            riskRating,
        },
    );
    return { createdRiskId: risk.id };
}

/**
 * Best-effort REVIEWED notification. Audited as part of the same
 * txn in `notifyAssessmentReviewed`-internal logEvent shim is
 * skipped — the reviewerNotes audit row already covers the human
 * action; the email is operational only.
 */
async function notifyAssessmentReviewed(
    assessmentId: string,
    finalScore: number,
    finalRating: string | null,
): Promise<void> {
    try {
        const a = await prisma.vendorAssessment.findUnique({
            where: { id: assessmentId },
            select: {
                tenantId: true,
                vendor: { select: { name: true, ownerUserId: true } },
                templateVersion: { select: { name: true } },
                tenant: { select: { slug: true } },
                requestedByUserId: true,
                vendorId: true,
            },
        });
        if (!a?.vendor || !a.templateVersion || !a.tenant) return;
        // Recipient: vendor owner if set, else the assessment requester.
        const recipientId =
            a.vendor.ownerUserId ?? a.requestedByUserId;
        const recipient = await prisma.user.findUnique({
            where: { id: recipientId },
            select: { email: true, name: true },
        });
        if (!recipient?.email) return;
        // env.APP_URL is the validated source of truth (src/env.ts).
        const origin = (env.APP_URL ?? '').replace(/\/$/, '');
        const reviewUrl = `${origin}/t/${a.tenant.slug}/admin/vendor-assessment-reviews/${assessmentId}`;

        await prisma.$transaction(async (tx) => {
            await enqueueEmail(tx, {
                tenantId: a.tenantId,
                type: 'VENDOR_ASSESSMENT_REVIEWED',
                toEmail: recipient.email!,
                entityId: assessmentId,
                payload: {
                    recipientName: recipient.name ?? 'there',
                    vendorName: a.vendor!.name,
                    templateName: a.templateVersion!.name,
                    reviewedAtIso: new Date().toISOString(),
                    finalScore,
                    finalRating,
                    reviewUrl,
                },
            });
        });
    } catch (err) {
        logger.warn('vendor-assessment-review: reviewed-notify failed', {
            component: 'vendor-assessment-review',
            assessmentId,
            err: err instanceof Error ? err : new Error(String(err)),
        });
    }
}

/**
 * Create an Evidence row + attach it to the vendor's "Vendor
 * Assessments" bundle. Runs in the same outer transaction (`db`)
 * so a failure rolls back the review itself.
 */
async function attachReviewedAssessmentEvidence(
    ctx: RequestContext,
    db: Parameters<Parameters<typeof runInTenantContext>[1]>[0],
    assessmentId: string,
    finalScore: number,
    finalRating: string | null,
): Promise<void> {
    const a = await db.vendorAssessment.findFirst({
        where: { id: assessmentId, tenantId: ctx.tenantId },
        select: {
            vendorId: true,
            templateVersion: { select: { name: true, key: true, version: true } },
        },
    });
    if (!a?.templateVersion) return;

    const content = [
        `Vendor questionnaire reviewed.`,
        `Template: ${a.templateVersion.name} (${a.templateVersion.key} v${a.templateVersion.version})`,
        `Final score: ${finalScore}`,
        `Risk rating: ${finalRating ?? '—'}`,
        `Reviewed at: ${new Date().toISOString()}`,
    ].join('\n');

    const evidence = await db.evidence.create({
        data: {
            tenantId: ctx.tenantId,
            type: 'TEXT',
            title: `Vendor assessment: ${a.templateVersion.name}`,
            content,
            category: 'vendor-assessment',
            status: 'APPROVED',
            ownerUserId: ctx.userId,
        },
        select: { id: true },
    });

    // Get-or-create the vendor's "Vendor Assessments" bundle.
    let bundle = await db.vendorEvidenceBundle.findFirst({
        where: {
            tenantId: ctx.tenantId,
            vendorId: a.vendorId,
            name: 'Vendor Assessments',
        },
        select: { id: true },
    });
    if (!bundle) {
        bundle = await db.vendorEvidenceBundle.create({
            data: {
                tenantId: ctx.tenantId,
                vendorId: a.vendorId,
                name: 'Vendor Assessments',
                description:
                    'Reviewed questionnaire results — auto-attached on review completion.',
                createdByUserId: ctx.userId,
            },
            select: { id: true },
        });
    }

    await db.vendorEvidenceBundleItem.create({
        data: {
            tenantId: ctx.tenantId,
            bundleId: bundle.id,
            entityType: 'Evidence',
            entityId: evidence.id,
            snapshotJson: {
                assessmentId,
                templateName: a.templateVersion.name,
                finalScore,
                finalRating,
                reviewedAt: new Date().toISOString(),
            },
        },
    });

    await logEvent(db, ctx, {
        action: 'VENDOR_ASSESSMENT_EVIDENCE_ATTACHED',
        entityType: 'Vendor',
        entityId: a.vendorId,
        details: `Attached reviewed assessment as evidence (score=${finalScore}, rating=${finalRating ?? 'none'})`,
        detailsJson: {
            category: 'entity_lifecycle',
            entityName: 'VendorEvidenceBundleItem',
            operation: 'created',
            after: {
                vendorId: a.vendorId,
                bundleId: bundle.id,
                evidenceId: evidence.id,
                assessmentId,
                finalScore,
                finalRating,
            },
            summary: `Reviewed assessment attached as vendor risk evidence`,
        },
    });
}

// ─── 2. getReviewView ──────────────────────────────────────────────

export interface ReviewViewQuestion {
    id: string;
    sectionId: string;
    sortOrder: number;
    prompt: string;
    answerType: string;
    required: boolean;
    weight: number;
    optionsJson: unknown;
    scaleConfigJson: unknown;
}
export interface ReviewViewSection {
    id: string;
    sortOrder: number;
    title: string;
    description: string | null;
    questions: ReviewViewQuestion[];
}
export interface ReviewViewAnswer {
    questionId: string;
    answerJson: unknown;
    computedPoints: number;
    reviewerOverridePoints: number | null;
    reviewerNotes: string | null;
    evidenceId: string | null;
}
export interface ReviewView {
    assessmentId: string;
    status: string;
    vendor: { id: string; name: string };
    template: {
        id: string;
        key: string;
        version: number;
        name: string;
        description: string | null;
        isPublished: boolean;
    };
    sections: ReviewViewSection[];
    answers: ReviewViewAnswer[];
    /** Live engine output computed against the current answer state. */
    scoring: ScoringResult;
    submittedAt: string | null;
    reviewedAt: string | null;
    reviewedByUserId: string | null;
    reviewerNotes: string | null;
    riskRating: string | null;
    closedAt: string | null;
}

/**
 * Read-only review view. Loads the assessment + template tree +
 * answers and runs the scoring engine fresh against the current
 * answer state (post-override) so the UI sees a live "what would
 * the score be" preview before any save.
 *
 * Permission gate: canRead — every authenticated tenant member can
 * inspect the review surface; only admins can submit it.
 */
export async function getReviewView(
    ctx: RequestContext,
    assessmentId: string,
): Promise<ReviewView> {
    if (!ctx.permissions.canRead) {
        // 403, not 400. An authorization denial is not a malformed request —
        // a 400 tells the caller to fix their input, and tells monitoring
        // this was a client-side validation error rather than an access
        // refusal, so real denials never surface as such.
        throw forbidden('Read access required.');
    }

    return runInTenantContext(ctx, async (db) => {
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: {
                id: true,
                status: true,
                vendorId: true,
                templateVersionId: true,
                submittedAt: true,
                reviewedAt: true,
                reviewedByUserId: true,
                reviewerNotes: true,
                riskRating: true,
                closedAt: true,
            },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (!assessment.templateVersionId) {
            throw badRequest(
                'This assessment was not created from a G-3 template.',
            );
        }

        const [vendor, template, answers] = await Promise.all([
            db.vendor.findUnique({
                where: { id: assessment.vendorId },
                select: { id: true, name: true },
            }),
            db.vendorAssessmentTemplate.findUnique({
                where: { id: assessment.templateVersionId },
                select: {
                    id: true,
                    key: true,
                    version: true,
                    name: true,
                    description: true,
                    isPublished: true,
                    scoringConfigJson: true,
                    sections: {
                        orderBy: { sortOrder: 'asc' },
                        include: {
                            questions: { orderBy: { sortOrder: 'asc' } },
                        },
                    },
                    questions: { orderBy: { sortOrder: 'asc' } },
                },
            }),
            db.vendorAssessmentAnswer.findMany({
                where: {
                    assessmentId: assessment.id,
                    tenantId: ctx.tenantId,
                },
                select: {
                    questionId: true,
                    answerJson: true,
                    computedPoints: true,
                    reviewerOverridePoints: true,
                    reviewerNotes: true,
                    evidenceId: true,
                },
            }),
        ]);
        if (!vendor || !template) throw notFound('Assessment context not found');

        const config = parseScoringConfig(template.scoringConfigJson);
        const scoring = scoreAssessment({
            questions: template.questions.map((q) => ({
                id: q.id,
                weight: q.weight,
                required: q.required,
            })),
            answers,
            config,
        });

        return {
            assessmentId: assessment.id,
            status: assessment.status,
            vendor: { id: vendor.id, name: vendor.name },
            template: {
                id: template.id,
                key: template.key,
                version: template.version,
                name: template.name,
                description: template.description,
                isPublished: template.isPublished,
            },
            sections: template.sections.map((s) => ({
                id: s.id,
                sortOrder: s.sortOrder,
                title: s.title,
                description: s.description,
                questions: s.questions.map((q) => ({
                    id: q.id,
                    sectionId: q.sectionId,
                    sortOrder: q.sortOrder,
                    prompt: q.prompt,
                    answerType: q.answerType,
                    required: q.required,
                    weight: q.weight,
                    optionsJson: q.optionsJson,
                    scaleConfigJson: q.scaleConfigJson,
                })),
            })),
            answers: answers.map((a) => ({
                questionId: a.questionId,
                answerJson: a.answerJson,
                computedPoints: a.computedPoints,
                reviewerOverridePoints: a.reviewerOverridePoints,
                reviewerNotes: a.reviewerNotes,
                evidenceId: a.evidenceId,
            })),
            scoring,
            submittedAt: assessment.submittedAt?.toISOString() ?? null,
            reviewedAt: assessment.reviewedAt?.toISOString() ?? null,
            reviewedByUserId: assessment.reviewedByUserId,
            reviewerNotes: assessment.reviewerNotes,
            riskRating: assessment.riskRating,
            closedAt: assessment.closedAt?.toISOString() ?? null,
        };
    });
}

// ─── 2b. listReviewableAssessments ─────────────────────────────────

export interface ReviewableAssessmentRow {
    id: string;
    vendorId: string;
    vendorName: string;
    status: string;
    score: number | null;
    riskRating: VendorCriticality | null;
    submittedAt: string | null;
    reviewedAt: string | null;
}

/**
 * Review-queue list. Returns the tenant's G-3 assessments
 * (`templateVersionId` non-null) that have reached the reviewable /
 * reviewed set — status SUBMITTED, REVIEWED, or CLOSED — for the
 * reviewer index page. Ordered SUBMITTED-first (the actionable
 * backlog rises to the top), then by `submittedAt` descending.
 *
 * Bounded at 200 rows. Permission gate: canRead — every
 * authenticated tenant member can inspect the review queue; only
 * admins can act on an individual assessment.
 */
export async function listReviewableAssessments(
    ctx: RequestContext,
): Promise<ReviewableAssessmentRow[]> {
    if (!ctx.permissions.canRead) {
        // 403, not 400. An authorization denial is not a malformed request —
        // a 400 tells the caller to fix their input, and tells monitoring
        // this was a client-side validation error rather than an access
        // refusal, so real denials never surface as such.
        throw forbidden('Read access required.');
    }

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.vendorAssessment.findMany({
            where: {
                tenantId: ctx.tenantId,
                templateVersionId: { not: null },
                status: { in: ['SUBMITTED', 'REVIEWED', 'CLOSED'] },
            },
            select: {
                id: true,
                vendorId: true,
                status: true,
                score: true,
                riskRating: true,
                submittedAt: true,
                reviewedAt: true,
                vendor: { select: { name: true } },
            },
            orderBy: { submittedAt: 'desc' },
            take: 200,
        });

        // Stable partition — SUBMITTED (actionable) first, preserving
        // the submittedAt-desc order the DB already applied within each
        // partition.
        const submitted = rows.filter((r) => r.status === 'SUBMITTED');
        const rest = rows.filter((r) => r.status !== 'SUBMITTED');

        return [...submitted, ...rest].map((r) => ({
            id: r.id,
            vendorId: r.vendorId,
            vendorName: r.vendor?.name ?? '',
            status: r.status,
            score: r.score,
            riskRating: r.riskRating,
            submittedAt: r.submittedAt?.toISOString() ?? null,
            reviewedAt: r.reviewedAt?.toISOString() ?? null,
        }));
    });
}

// ─── 2c. listVendorAssessments (PR-S) ──────────────────────────────

export interface VendorAssessmentRow {
    id: string;
    status: string;
    score: number | null;
    riskRating: VendorCriticality | null;
    /** Template display name — prefers the G-3 templateVersion (G-3 rows have
     *  templateId=null), falling back to the legacy template, else null. */
    templateName: string | null;
    startedAt: string | null;
    sentAt: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
    closedAt: string | null;
    respondentEmail: string | null;
    /**
     * When the external respondent link dies, and whether an operator killed
     * it early. Both were absent, so a SENT assessment whose token expired
     * three weeks ago rendered identically to one sent this morning —
     * "Outstanding, awaiting response", with a Resend button and no hint
     * that the respondent has had no working link for most of that time.
     */
    inviteExpiresAt: string | null;
    inviteRevokedAt: string | null;
}

/**
 * PR-S — the vendor-detail Assessments tab list. Restores the assessments the
 * vendor `getById` payload never carried (a regression that left the tab empty).
 * Returns ALL of a vendor's assessments across every status, with the template
 * NAME resolved through `templateVersion` for G-3 rows (whose `templateId` is
 * null). canRead gate — the tab is a read surface.
 */
export async function listVendorAssessments(
    ctx: RequestContext,
    vendorId: string,
): Promise<VendorAssessmentRow[]> {
    if (!ctx.permissions.canRead) {
        // 403, not 400. An authorization denial is not a malformed request —
        // a 400 tells the caller to fix their input, and tells monitoring
        // this was a client-side validation error rather than an access
        // refusal, so real denials never surface as such.
        throw forbidden('Read access required.');
    }

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.vendorAssessment.findMany({
            where: { tenantId: ctx.tenantId, vendorId },
            select: {
                id: true,
                status: true,
                score: true,
                riskRating: true,
                startedAt: true,
                sentAt: true,
                submittedAt: true,
                reviewedAt: true,
                closedAt: true,
                respondentEmail: true,
                // The invite's lifecycle, without which the surface cannot
                // tell a link sent this morning from one that died three
                // weeks ago — both rendered as "awaiting response" with a
                // Resend button and nothing to distinguish them.
                externalAccessTokenExpiresAt: true,
                revokedAt: true,
                template: { select: { name: true } },
                templateVersion: { select: { name: true } },
            },
            // Ordered by createdAt to match how EVERY other surface defines "the
            // latest assessment" — the activation gate, getVendorMetrics, and the
            // dashboard risk buckets all use `orderBy createdAt desc take 1`.
            // This previously ordered by `startedAt`, which drifts from that
            // whenever startedAt is null or set later than the row was created,
            // so the assessment shown at the top of this list was not necessarily
            // the one the gate and the dashboard were reasoning about.
            orderBy: { createdAt: 'desc' },
            take: 200,
        });

        return rows.map((r) => ({
            id: r.id,
            status: r.status,
            score: r.score,
            riskRating: r.riskRating,
            templateName: r.templateVersion?.name ?? r.template?.name ?? null,
            startedAt: r.startedAt?.toISOString() ?? null,
            sentAt: r.sentAt?.toISOString() ?? null,
            submittedAt: r.submittedAt?.toISOString() ?? null,
            reviewedAt: r.reviewedAt?.toISOString() ?? null,
            closedAt: r.closedAt?.toISOString() ?? null,
            respondentEmail: r.respondentEmail,
            inviteExpiresAt: r.externalAccessTokenExpiresAt?.toISOString() ?? null,
            inviteRevokedAt: r.revokedAt?.toISOString() ?? null,
        }));
    });
}

// ─── 3. closeAssessment ────────────────────────────────────────────

export async function closeAssessment(
    ctx: RequestContext,
    assessmentId: string,
    notes?: string | null,
): Promise<CloseAssessmentResult> {
    assertCanApproveAssessment(ctx);

    return runInTenantContext(ctx, async (db) => {
        const assessment = await db.vendorAssessment.findFirst({
            where: { id: assessmentId, tenantId: ctx.tenantId },
            select: { id: true, status: true },
        });
        if (!assessment) throw notFound('Assessment not found');
        if (assessment.status !== 'REVIEWED') {
            throw badRequest(
                `Cannot close an assessment in status ${assessment.status}. ` +
                    `Only REVIEWED assessments can be closed.`,
            );
        }

        const closedAt = new Date();
        await db.vendorAssessment.update({
            where: { id: assessment.id },
            data: {
                status: 'CLOSED',
                closedAt,
                closedByUserId: ctx.userId,
                ...(notes !== undefined && {
                    reviewerNotes: notes
                        ? sanitizePlainText(notes)
                        : null,
                }),
            },
        });

        await logEvent(db, ctx, {
            action: 'VENDOR_ASSESSMENT_CLOSED',
            entityType: 'VendorAssessment',
            entityId: assessment.id,
            details: `Closed reviewed assessment`,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: 'VendorAssessment',
                operation: 'closed',
                after: {
                    status: 'CLOSED',
                    closedAt: closedAt.toISOString(),
                },
                summary: `Vendor assessment closed`,
            },
        });

        return { status: 'CLOSED' as const, closedAt };
    });
}

// ─── Helpers ───────────────────────────────────────────────────────

function formatScore(n: number): string {
    if (Number.isInteger(n)) return n.toString();
    return n.toFixed(3);
}
